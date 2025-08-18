const Nodehun = require('nodehun');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const findProcess = require('find-process');
const killPort = require('kill-port');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const spell = require('spellchecker');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
// const { Configuration, OpenAIApi } = require('openai');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
//const fetch = require('node-fetch');
const { PassThrough } = require('stream');
const { OpenAI } = require('openai');
const crypto = require('crypto');



// --- DIAGNOSTIC LOG: Check if API key is loaded ---
console.log("OPENAI_API_KEY loaded:", process.env.OPENAI_API_KEY ? "Yes (length: " + process.env.OPENAI_API_KEY.length + ")" : "No");

const app = express();
const port = 5000;

function normalizeQuestion(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[“”"‘’']/g, "'")
    .replace(/[^a-z0-9\s\-\+\*\(\)\/\.,:;=]/g, '') // keep common math & punctuation
    .trim();
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ================== AUTH MIDDLEWARE ==================
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) {
    return res.status(401).json({ error: 'Authentication token required.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.error("JWT verification error:", err.message);
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
};
// Allow CORS for all origins, methods, and headers.
app.use(cors({ origin: ['http://127.0.0.1:8080', 'http://localhost:8080', 'https://mentoro-ai-dev-backend.onrender.com'], // Explicitly allow your frontend origins
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false, // Set to true if you need cookies or credentials
    exposedHeaders: ['Content-Type']}));
app.use(express.json());

// Load API keys and secrets from environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

// --- In-Memory Cache ---
const explanationCache = new Map();
const quizCache = new Map();

// 🚫 Safety Keywords
const SENSITIVE_KEYWORDS = ['sex', 'sexual', 'desire', 'religion', 'politics', 'violence', 'terrorism', 'drugs', 'drug abuse', 'alcohol', 'weapons', 'crime', 'hate speech', 'suicide', 'death', 'killing'];

// ================== PROMPT ENGINEERING HELPER FUNCTIONS ==================
const getToneForClass = (grade) => {
  if (['Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5'].includes(grade)) {
    return "fun, playful, and highly engaging with simple words";
  } else if (['Class 6', 'Class 7', 'Class 8'].includes(grade)) {
    return "friendly, encouraging, and clear with some basic technical terms";
  } else {
    return "formal, concise, and academically rigorous with proper technical terms";
  }
};

const getDepthInstructions = (grade) => {
  if (['Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5'].includes(grade)) {
    return {
      greeting: "Hello little champions! 🌟",
      sections: ["Simple Definition", "Fun Examples", "Cool Fact"],
      instructions: "Use only very basic concepts. Give 2 super simple examples from daily life that a child would understand. No technical terms.",
      exampleCount: 2
    };
  } else if (['Class 6', 'Class 7', 'Class 8'].includes(grade)) {
    return {
      greeting: "Hello young learners! 😊",
      sections: ["Definition", "Explanation", "Examples", "Did You Know?"],
      instructions: "Introduce simple technical terms with easy explanations. Provide 2-3 relatable examples. Include one interesting fact.",
      exampleCount: 3
    };
  } else {
    return {
      greeting: "Hello students! 📚",
      sections: ["Scientific Definition", "Detailed Explanation", "Real-World Applications", "Key Concepts"],
      instructions: "Include proper technical terms and formulas (mark them **bold**). Explain concepts thoroughly with 3-4 real-world applications. Connect to fundamental principles.",
      exampleCount: 4
    };
  }
};

const getLanguageInstructions = (language) => {
  let langInstruction = "";
  let langExamples = "";

  switch (language) {
    case "Gujarati":
      langInstruction = "તમારું સમજૂતી ગુજરાતીમાં આપો.";
      langExamples = "ગુજરાતી ઉદાહરણો";
      break;
    case "Hindi":
      langInstruction = "अपनी व्याख्या हिंदी में दें।";
      langExamples = "हिंदी उदाहरण";
      break;
    case "Kannada":
      langInstruction = "ನಿಮ್ಮ ವಿವರಣೆಯನ್ನು ಕನ್ನಡದಲ್ಲಿ ನೀಡಿ.";
      langExamples = "ಕನ್ನಡ ಉದಾಹರಣೆಗಳು";
      break;
    case "Tamil":
      langInstruction = "உங்கள் விளக்கத்தை தமிழில் வழங்கவும்.";
      langExamples = "தமிழ் எடுத்துக்காட்டுகள்";
      break;
    case "Telugu":
      langInstruction = "మీ వివరణను తెలుగులో అందించండి.";
      langExamples = "తెలుగు ఉదాహరణలు";
      break;
    case "Marathi":
      langInstruction = "तुमची स्पष्टीकरण मराठीत द्या.";
      langExamples = "मराठी उदाहरणे";
      break;
    default:
      langInstruction = "Provide your explanation in English.";
      langExamples = "English examples";
  }
  return { langInstruction, langExamples };
};

// ================== PROMPT BUILDERS ==================
const buildExplanationPrompt = (topic, grade, language, role) => {
  const { langInstruction, langExamples } = getLanguageInstructions(language);
  const { greeting, sections, instructions, exampleCount } = getDepthInstructions(grade);
  const tone = getToneForClass(grade);

  return `
You are an expert AI tutor for ${grade} students in India. ${greeting}

**Topic:** Explain "${topic}" with:
- **Tone:** ${tone}
- **Language:** ${langInstruction}
- **Complexity:** Perfectly suited for ${grade}
- **Role:** ${role}

**Required Sections (use these headings):**
1. <strong>${sections[0]}:</strong><br/>
2. <strong>${sections[1]}:</strong><br/>
3. <strong>${sections[2]}:</strong><br/>

**Formatting Rules:**
- Format all section titles in: <strong>Section Title:</strong><br/>
- Use <br/> for line breaks between items or points.
- Return output in clean, readable HTML format (no markdown).
- Keep answers clear and structured in sections as above.

**Special Rules:**
${instructions}
${['Class 9', 'Class 10', 'Class 11', 'Class 12'].includes(grade) ?
  "- Include <strong>bold</strong> technical terms<br/>- Add relevant formulas<br/>- Connect to real-world applications" :
  "- Use simple analogies and fun examples"}

**Example Output:**

"${greeting}"<br/><br/>

<strong>${sections[0]}:</strong><br/>
[Clear ${language} definition]<br/><br/>

<strong>${sections[1]}:</strong><br/>
${grade <= 5 ?
  "1) [Child-friendly example 1]<br/>2) [Example 2]" :
  "1) [NCERT-style example]<br/>2) [Real-world application]<br/>3) [Additional example]"
}<br/><br/>

<strong>${sections[2]}:</strong><br/>
[${grade <= 8 ? "Interesting fact" : "Key scientific principle"}]<br/>
`.trim();
};

const buildQuizPrompt = (question, explanation, grade, language) => {
  const { langInstruction } = getLanguageInstructions(language);
  const { greeting } = getDepthInstructions(grade);

  return `
  Generate a quiz based on this ${grade}-level explanation (in ${language}):

  **Topic:** ${question}
  **Explanation:** ${explanation}

  **Requirements:**
  - Language: ${langInstruction}
  - Difficulty: Appropriate for ${grade}
  - Format: 3 MCQs with 4 options each
  - Mark correct answers with *
  - Include 1 conceptual, 1 application, and 1 formula-based question (if applicable)

  **Example:**
  1. What is the main idea of Newton's First Law?
  a) Force equals mass times acceleration
  b) Objects resist changes in motion*
  c) No reaction
  d) Energy cannot be created or destroyed

  3. The formula F=ma represents:
  a) Newton's First Law
  b) Newton's Second Law*
  c) Newton's Third Law
  d) Law of Gravitation

  Format options strictly as:
  a) Option 1
  b) Option 2
  c) Option 3*
  d) Option 4
  → Only one * at the end of the correct option, no extra asterisks.
  `.trim();
};

const buildPersonalizedPlanPrompt = (weakTopics, studentGrade, studentLanguage) => {
  const { langInstruction } = getLanguageInstructions(studentLanguage);
  const tone = getToneForClass(studentGrade);

  if (!weakTopics || weakTopics.length === 0) {
    return `
You are an AI tutor for ${studentGrade} in India. No weak topics were found. Make a 5-day revision plan for important chapters.

✅ Use emojis  
✅ Use headings for Day 1–5  
✅ Use clear simple language  
✅ Language: ${langInstruction}  
✅ Tone: ${tone}
    `.trim();
  }

  const topicsList = weakTopics.map(topic => `- ${topic.question} (score: ${topic.score}/3)`).join('\n');

  return `
You're an AI tutor for a ${studentGrade} student. Based on weak topics below, create a 5-day study plan:

🧠 Weak Topics:  
${topicsList}

Each Day should include:  
- Topic name  
- Why it’s hard  
- 3–4 steps to improve  
- 1 quiz question (MCQ)  
- A fun tip

✅ Use emojis and simple markdown  
✅ Language: ${langInstruction}  
✅ Tone: ${tone}
  `.trim();
};

// ================== USER AUTHENTICATION ENDPOINTS ==================
app.post('/api/signup', async (req, res) => {
  const { username, mobile_number, password, role, student_class } = req.body;

  if (!username || !mobile_number || !password || !role) {
    return res.status(400).json({ error: 'All fields are required (username, mobile, password, role).' });
  }
  if (role === 'Student' && !student_class) {
    return res.status(400).json({ error: 'Student role requires a class selection.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const { data: existingUsers, error: existingUserError } = await axios.get(
      `${SUPABASE_URL}/rest/v1/users?or=(username.eq.${username},mobile_number.eq.${mobile_number})`,
      { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } }
    );

    if (existingUserError) {
      console.error('Supabase check existing user error:', existingUserError);
      return res.status(500).json({ error: 'Database error checking existing users.' });
    }

    if (existingUsers && existingUsers.length > 0) {
      return res.status(409).json({ error: 'Username or mobile number already registered.' });
    }

    const { data, error } = await axios.post(
      `${SUPABASE_URL}/rest/v1/users`,
      {
        username,
        mobile_number,
        password_hash: hashedPassword,
        role,
        class: student_class || null
      },
      { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } }
    );

    if (error) {
      console.error('Supabase insert user error:', error);
      return res.status(500).json({ error: 'Failed to register user due to database error.' });
    }

    res.status(201).json({ message: 'User registered successfully!' });
  } catch (error) {
    console.error('Signup Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to register user. Please try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Identifier (username/mobile) and password are required.' });
  }

  try {
    const { data: users, error } = await axios.get(
      `${SUPABASE_URL}/rest/v1/users?or=(username.eq.${identifier},mobile_number.eq.${identifier})`,
      { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } }
    );

    if (error) {
      console.error('Supabase fetch user error:', error);
      return res.status(500).json({ error: 'Database error fetching user.' });
    }

    if (!users || users.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = users[0];
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, class: user.class },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ message: 'Login successful!', token, user: { id: user.id, username: user.username, role: user.role, class: user.class } });
  } catch (error) {
    console.error('Login Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to log in. Please try again.' });
  }
});

app.get('/api/user/profile', authenticateToken, (req, res) => {
  res.json({ message: `Welcome, ${req.user.username}!`, user: req.user });
});

// ================== STUDENT ACTIVITY & PERSONALIZED PLAN ENDPOINTS ==================
app.post('/api/save-activity', authenticateToken, async (req, res) => {
  const { question, grade, language, quiz_score } = req.body;
  const user_id = req.user?.id;
  const studentGrade = req.user?.class || "Class 8";
  const studentLanguage = req.body.language || 'English';

  const role = req.user.role;

  if (!user_id || !question || !grade || !language || quiz_score === undefined || quiz_score === null) {
    return res.status(400).json({ error: 'Missing required fields for student activity.' });
  }

  try {
    const { data, error } = await axios.post(
      `${SUPABASE_URL}/rest/v1/student_activity`,
      {
        user_id,
        question,
        grade,
        language,
        role,
        quiz_score,
        timestamp: new Date().toISOString()
      },
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (error) {
      console.error('Supabase save activity error:', error);
      return res.status(500).json({ error: 'Failed to save student activity.' });
    }

    res.status(201).json({ message: 'Student activity saved successfully!', data });
  } catch (error) {
    console.error('Save Activity Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to save student activity. Please try again.' });
  }
});

app.get('/api/student-activities', authenticateToken, async (req, res) => {
  const user_id = req.user.id;

  try {
    const { data: activities, error } = await axios.get(
      `${SUPABASE_URL}/rest/v1/student_activity?user_id=eq.${user_id}&order=timestamp.desc`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      }
    );

    if (error) {
      console.error('Supabase fetch activities error:', error);
      return res.status(500).json({ error: 'Failed to fetch student activities.' });
    }

    res.json({ activities });
  } catch (error) {
    console.error('Fetch Activities Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to fetch student activities. Please try again.' });
  }
});

app.post('/api/personalized-plan', authenticateToken, async (req, res) => {
  const user_id = req.user?.id;
  const studentGrade = req.user?.class || "Class 8";
  const studentLanguage = req.body.language || "English";

  if (!user_id || !studentGrade) {
    return res.status(400).json({ error: 'User ID and student grade are required for personalized plan.' });
  }

  try {
    const supabaseHeaders = {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    };

    // Fetch activities and build prompt in parallel
    const [activitiesResponse] = await Promise.all([
      axios.get(
        `${SUPABASE_URL}/rest/v1/student_activity?user_id=eq.${user_id}&select=question,quiz_score,grade,language`,
        supabaseHeaders
      )
    ]);

    const activities = activitiesResponse.data;

    // Weak topic computation
    const topicScores = {};
    activities.forEach(activity => {
      const key = activity.question;
      if (!topicScores[key]) {
        topicScores[key] = {
          totalScore: 0,
          count: 0,
          grade: activity.grade,
          language: activity.language
        };
      }
      topicScores[key].totalScore += activity.quiz_score;
      topicScores[key].count += 1;
    });

    const weakTopics = [];
    for (const topic in topicScores) {
      const avg = topicScores[topic].totalScore / topicScores[topic].count;
      if (avg <= 2) {
        weakTopics.push({
          question: topic,
          score: Math.round(avg),
          grade: topicScores[topic].grade,
          language: topicScores[topic].language
        });
      }
    }

    const prompt = buildPersonalizedPlanPrompt(weakTopics, studentGrade, studentLanguage);

    if (!prompt || typeof prompt !== 'string') {
      console.error("❌ Invalid prompt generated:", prompt);
      return res.status(500).json({ error: "AI prompt generation failed. Please check inputs." });
    }

    // OpenAI call
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a personalized AI tutor. Format your output with emojis, markdown headers, and line breaks for mobile readability.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const personalizedPlanContent = response.data.choices?.[0]?.message?.content;
    const formattedPlan = formatResponse(personalizedPlanContent, studentGrade);

    if (!personalizedPlanContent) {
      console.error("⚠️ OpenAI API returned empty content:", response.data);
      return res.status(500).json({ error: 'Failed to generate personalized plan from AI.' });
    }

    res.json({ personalizedPlan: formattedPlan });

  } catch (error) {
    console.error('Personalized Plan Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to generate personalized plan. Please try again.' });
  }
});

async function correctTextWithGPT(inputText) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is missing.");
    return inputText;
  }

  try {
    const prompt = `You are an intelligent AI assistant.

The following text was extracted from an image using OCR. It may contain:
- Spelling mistakes
- Misrecognized or broken words (especially from handwriting)
- Missing punctuation or formatting
- Incomplete sentences due to OCR limitations

Please carefully correct the text without changing its original meaning or tone.

Only return the cleaned, corrected version.

"""
${inputText}
"""`;

    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are an expert at cleaning OCR-extracted text and correcting spelling/contextual errors.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.2,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const finalText = response.data.choices[0].message.content.trim();
    return finalText || inputText;

  } catch (error) {
    console.error("GPT OCR cleanup failed:", error.message);
    return inputText; // fallback
  }
}

// ================== GLOBAL OCR WORKER ==================
let ocrWorker = null;
(async () => {
  try {
    ocrWorker = await createWorker('eng', 1, {
      langPath: path.join(__dirname, 'lang-data'),
      oem: 1,
    });

    await ocrWorker.setParameters({
      tessedit_pageseg_mode: '6', // Assume block of text
      user_defined_dpi: '450',
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+-=*/()^',
    });

    console.log("✅ Tesseract OCR worker initialized.");
  } catch (err) {
    console.error("❌ Failed to init OCR worker:", err);
  }
})();

// ================== OCR ENDPOINT ==================
app.post('/api/ocr', authenticateToken, async (req, res) => {
  const { image } = req.body;

  if (!image) return res.status(400).json({ error: 'Image data is required.' });
  if (!image.match(/^data:image\/(jpeg|png);base64,/))
    return res.status(400).json({ error: 'Invalid image format. Only JPEG or PNG is supported.' });

  try {
    const buffer = Buffer.from(image.replace(/^data:image\/(jpeg|png);base64,/, ''), 'base64');

    // Preprocess into 3 optimized versions (gray, handwriting boost, blue ink with milder sharpen and no aggressive threshold)
    const [grayBuffer, handwritingBuffer, blueInkBuffer] = await Promise.all([
      sharp(buffer)
        .resize({ width: 1200, withoutEnlargement: true })
        .grayscale()
        .modulate({ brightness: 1.3, contrast: 1.6 })
        .sharpen()
        .toFormat('png')
        .toBuffer(),

      sharp(buffer)
        .resize({ width: 1200, withoutEnlargement: true })
        .modulate({ brightness: 1.5, contrast: 2.0, saturation: 2.0 })
        .sharpen({ sigma: 0.7 }) // gentler sharpen for handwriting
        .toFormat('png')
        .toBuffer(),

      sharp(buffer)
        .resize({ width: 1200, withoutEnlargement: true })
        .modulate({ brightness: 1.5, saturation: 2.0 })
        // No aggressive threshold or heavy tinting here to avoid distortion
        .sharpen({ sigma: 0.7 })
        .toFormat('png')
        .toBuffer(),
    ]);

    if (!ocrWorker) {
      return res.status(500).json({ error: 'OCR engine not initialized.' });
    }

    const variants = [grayBuffer, handwritingBuffer, blueInkBuffer];
    let bestResult = null;

    // Set strong Tesseract params for math/text recognition before OCR
    await ocrWorker.setParameters({
      tessedit_char_whitelist: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ^=+-*/(). ',
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: '6',
      user_defined_dpi: '450',
    });

    // Run sequential OCR with early cutoff for high confidence
    for (let i = 0; i < variants.length; i++) {
      const result = await ocrWorker.recognize(variants[i]);
      const { text, confidence } = result.data;

      if (!bestResult || confidence > bestResult.confidence) {
        bestResult = { text, confidence, variant: i };
      }

      if (confidence > 85 && text.trim().length > 20) {
        console.log(`✅ Early stop: OCR good enough on variant ${i}, confidence ${confidence}`);
        break;
      }
    }

    let extractedText = bestResult?.text || "";

    console.log("Best OCR Variant:", bestResult?.variant);
    console.log("OCR Confidence:", bestResult?.confidence);

    // Check if math-like text but low confidence or too short → fallback to OpenAI Vision OCR
    const mathLike = /[0-9x=+\-*/()]/.test(extractedText);
    if (
      !extractedText.trim() ||
      bestResult.confidence < 70 ||
      extractedText.length < 20 ||
      (mathLike && extractedText.split(" ").length <= 5)
    ) {
      console.log("⚠️ Falling back to OpenAI Vision OCR...");
      const visionText = await extractTextWithOpenAIVision(buffer);

      if (visionText && visionText.trim().length > 10) {
        extractedText = visionText;
      } else {
        return res.status(400).json({ error: "OCR failed. Vision model could not extract usable text." });
      }
    }

    // Clean text: remove non-ASCII, excess spaces, control chars
    let cleanedText = extractedText
      .replace(/[^\x00-\x7F]/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/[-\u001F]+/g, " ")
      .trim();

    // Spell correction
    const wordsArray = cleanedText.split(/\s+/);
    const correctedWords = wordsArray.map(word => {
      if (spell.isMisspelled(word)) {
        return spell.getCorrectionsForMisspelling(word)[0] || word;
      }
      return word;
    });
    const correctedText = correctedWords.join(" ");

    // GPT contextual cleanup, math-aware with explicit instruction for math symbol fixes
    const finalCorrectedText = await correctTextWithGPT(`
The following OCR text contains a handwritten or printed math expression. Carefully correct OCR errors 
including minus/plus sign confusions, variable misreadings such as 'r' vs 'b', 
and misplaced parentheses or exponents without changing the problem meaning. 
Preserve and output all math symbols and variables accurately with correct spacing.

Input:
${correctedText}
    `);

    // Post-OCR lightweight fixes for common symbol confusions (customize per your most frequent errors)
    let postProcessedText = finalCorrectedText
      .replace(/\bb\b/g, 'r')    // Fix misread 'b' to 'r' if fits context
      .replace(/a \+ 1/g, 'a - 1') // Fix flipped plus to minus in critical places
      .replace(/- 7a/g, '+ 7a');   // Example sign fix, adjust as needed

    console.log("📘 Final OCR Output:", postProcessedText);
    return res.json({ text: postProcessedText });
  } catch (error) {
    console.error("❌ OCR Error:", error.message, error.stack);
    return res.status(500).json({
      error: "Failed to process OCR. Ensure the image contains clear text and good lighting.",
      details: error.message,
    });
  }
});





async function extractTextWithOpenAIVision(imageBuffer) {
  const base64Image = imageBuffer.toString('base64');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: 'You are a helpful OCR assistant. Extract all clear, readable text from the image. Focus on textbook-style academic content.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    max_tokens: 1000,
  });

  return response.choices[0].message.content;
}
// ================== EXISTING AI API ENDPOINTS ==================
app.post('/api/explain', authenticateToken, async (req, res) => {
  const { question, grade, language, role, fastMode = false } = req.body;
  const userId = req.user?.id;
  const username = req.user?.username;
  const cacheKey = `${question}-${grade}-${language}-${role}-${fastMode}`;
  const today = new Date().toISOString().split('T')[0];

  const lowerQuestion = question.toLowerCase();
  if (SENSITIVE_KEYWORDS.some(k => lowerQuestion.includes(k))) {
    return res.json({ explanation: `⚠️ I can't explain this topic as it may contain sensitive content.` });
  }

  // 1) In-memory cache
  if (explanationCache.has(cacheKey)) {
    return res.json({ explanation: explanationCache.get(cacheKey) });
  }

  // 2) Supabase cache check
  const normalized = normalizeQuestion(question);
  const qhash = sha256(`${normalized}|${grade}|${language}|${role}|${fastMode}`);
  try {
    const { data: cached, error: cacheErr } = await supabase
      .from('answer_cache')
      .select('answer_html, id, uses')
      .eq('qhash', qhash)
      .eq('grade', grade)
      .eq('language', language)
      .eq('role', role)
      .eq('fast_mode', !!fastMode)
      .maybeSingle();

    if (!cacheErr && cached?.answer_html) {
      // update metadata in background
      supabase.from('answer_cache')
        .update({ uses: (cached.uses || 1) + 1, last_used: new Date().toISOString() })
        .eq('id', cached.id);

      explanationCache.set(cacheKey, cached.answer_html);
      return res.json({ explanation: cached.answer_html });
    }
  } catch (e) {
    console.error('Supabase read error (answer_cache):', e.message);
  }

  try {
    const isUnlimitedUser = username === 'fshekh';
    if (!isUnlimitedUser) {
      const { data, error } = await supabase
        .from('usage_limits')
        .select('explain_count')
        .eq('user_id', userId)
        .eq('date', today)
        .maybeSingle();

      if (error) {
        console.error('Supabase usage fetch error:', error.message);
        return res.status(500).json({ error: 'Unable to check usage limits.' });
      }

      if (data?.explain_count >= 10) {
        return res.status(429).json({
          error: '🚫 Daily explanation limit reached (10 per day). Please try again tomorrow.'
        });
      }
    }

    const prompt = buildExplanationPrompt(question, grade, language, role);
    const model = fastMode ? 'gpt-4o-mini' : 'gpt-4o';

    const responseStream = await axios({
      method: 'post',
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: {
        model,
        messages: [
          {
            role: "system",
            content: "You are a helpful AI tutor who adapts explanations perfectly to grade level. Return content in Markdown with clear sections."
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.6,
        max_tokens: fastMode ? 400 : 900,
        stream: true,
      },
      responseType: 'stream',
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let streamed = '';

    responseStream.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const json = line.replace(/^data: /, '');
          if (json === '[DONE]') {
            res.write('\n\n');
            res.end();
            return;
          }
          try {
            const parsed = JSON.parse(json);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              res.write(content);
              streamed += content;
            }
          } catch (e) {
            console.error("Parsing error:", e);
          }
        }
      }
    });

    responseStream.data.on('end', async () => {
      if (!isUnlimitedUser) {
        await supabase
          .from('usage_limits')
          .upsert([{ user_id: userId, date: today, explain_count: 1 }], { onConflict: ['user_id', 'date'] });
      }

      // Save to memory + Supabase
      explanationCache.set(cacheKey, streamed);
      try {
        await supabase.from('answer_cache').upsert({
          question_raw: question,
          question_normalized: normalized,
          qhash,
          grade,
          language,
          role,
          fast_mode: !!fastMode,
          answer_html: streamed,
          model,
          tokens: null,
          uses: 1,
          last_used: new Date().toISOString()
        }, { onConflict: 'qhash,grade,language,role,fast_mode' });
      } catch (e) {
        console.error('Supabase upsert error (answer_cache):', e.message);
      }

      console.log(`✅ Explanation streamed & cached`);
    });

    responseStream.data.on('error', (err) => {
      console.error('Stream Error:', err);
      res.end();
    });

  } catch (error) {
    console.error('Explanation Stream Error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Failed to generate explanation. Please try again.' });
  }
});


//const configuration = new Configuration({
//  apiKey: process.env.OPENAI_API_KEY
//});
//const openai = new OpenAIApi(configuration);

app.post('/api/quiz', authenticateToken, async (req, res) => {
  const { question, explanation, grade, language, role } = req.body;
  const cacheKey = `${question}-${grade}-${language}-quiz`;

  console.log(`[Quiz Log] Received quiz request for topic: "${question}" (Grade: ${grade}, Language: ${language})`);

  // 1) In-memory cache
  if (quizCache.has(cacheKey)) {
    console.log(`[Quiz Log] Returning quiz from cache for topic: "${question}"`);
    return res.json({ questions: quizCache.get(cacheKey) });
  }

  // 2) Supabase cache
  const normalized = normalizeQuestion(question);
  const qhash = sha256(`${normalized}|${grade}|${language}|${role}`);
  try {
    const { data: cached, error: cacheErr } = await supabase
      .from('quiz_cache')
      .select('quiz_json, id, uses')
      .eq('qhash', qhash)
      .eq('grade', grade)
      .eq('language', language)
      .eq('role', role)
      .maybeSingle();

    if (!cacheErr && cached?.quiz_json) {
      supabase.from('quiz_cache')
        .update({ uses: (cached.uses || 1) + 1, last_used: new Date().toISOString() })
        .eq('id', cached.id);

      quizCache.set(cacheKey, cached.quiz_json);
      return res.json({ questions: cached.quiz_json });
    }
  } catch (e) {
    console.error('Supabase read error (quiz_cache):', e.message);
  }

  const lowerQuestion = question.toLowerCase();
  if (SENSITIVE_KEYWORDS.some(k => lowerQuestion.includes(k))) {
    console.warn(`[Quiz Log] Sensitive content detected in quiz request for "${question}". Aborting quiz generation.`);
    return res.json({ questions: [] });
  }

  try {
    const prompt = buildQuizPrompt(question, explanation, grade, language);
    console.log('[Quiz Log] Prompt sent to LLM for quiz generation:', prompt);

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not defined.");
      return res.status(500).json({ questions: [], error: "Server configuration error: OpenAI API key is missing." });
    }

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: "system", content: "You are an expert in creating multiple-choice quizzes based on provided text, adhering strictly to the requested format." },
          { role: "user", content: prompt }
        ],
        temperature: 0.7,
      },
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
      }
    );

    const rawQuizResponse = response.data.choices[0].message.content;
    console.log('[Quiz Log] Raw response from LLM for quiz:', rawQuizResponse);

    const parsedQuestions = parseQuiz(rawQuizResponse);

    // Save to memory + Supabase
    quizCache.set(cacheKey, parsedQuestions);
    try {
      await supabase.from('quiz_cache').upsert({
        question_raw: question,
        question_normalized: normalized,
        qhash,
        grade,
        language,
        role,
        quiz_json: parsedQuestions,
        uses: 1,
        last_used: new Date().toISOString()
      }, { onConflict: 'qhash,grade,language,role' });
    } catch (e) {
      console.error('Supabase upsert error (quiz_cache):', e.message);
    }

    console.log(`[Quiz Log] Successfully generated and parsed ${parsedQuestions.length} quiz questions.`);
    res.json({ questions: parsedQuestions });
  } catch (error) {
    console.error('[Quiz Log] Error generating quiz from LLM:', error.response ? error.response.data : error.message);
    res.status(500).json({ questions: [], error: 'Failed to generate quiz. Please try again.' });
  }
});


// ================== HELPER FUNCTIONS FOR AI RESPONSE PARSING ==================
function formatResponse(text, grade) {
  let formattedText = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  formattedText = formattedText.replace(/\n/g, '<br/>');
  formattedText = formattedText.replace(/<br\/>(\d+\)\s*)/g, '<br/><br/>$1');
  formattedText = formattedText.replace(/<br\/>(-\s*)/g, '<br/><br/>$1');

  const { sections } = getDepthInstructions(grade);
  sections.forEach(title => {
    const regex = new RegExp(`(<strong>${title}:<\\/strong>)(?!<br\\/?>)`, 'gi');
    formattedText = formattedText.replace(regex, '$1<br/><br/>');
  });

  return formattedText;
}

function parseQuiz(content) {
  console.log(`[Quiz] Parsing quiz content: ${content}`);
  const questions = [];
  const questionBlocks = content.split(/(?=\d+\.\s)/).filter(block => block.trim());

  for (const block of questionBlocks) {
    const questionMatch = block.match(/^(\d+\.\s*.*?)(?=\n\s*[a-d]\))/s);
    if (!questionMatch) {
      console.warn(`[Quiz] Could not parse question block: "${block.trim()}"`);
      continue;
    }

    const questionText = questionMatch[1].replace(/^\d+\.\s*/, '').trim();
    console.log(`[Quiz] Found question: ${questionText}`);

    const optionsBlock = block.slice(questionMatch[0].length).trim();
    console.log(`[Quiz] Options block: ${optionsBlock}`);

    const options = [];
    let correctAnswer = '';
    const optionRegex = /([a-d])\)\s*(.*?)(?=\n\s*[a-d]\)|\n*$)/gs;
    let optionMatch;

    while ((optionMatch = optionRegex.exec(optionsBlock)) !== null) {
      let optionText = optionMatch[2].trim();
      const isCorrect = optionText.endsWith('*');
      if (isCorrect) {
        optionText = optionText.slice(0, -1).trim();
        correctAnswer = `${optionMatch[1]}) ${optionText}`;
      }
      options.push(`${optionMatch[1]}) ${optionText}`);
    }

    console.log(`[Quiz] Parsed options: ${JSON.stringify(options)}`);
    console.log(`[Quiz] Correct answer: "${correctAnswer}"`);

    if (questionText && options.length === 4 && correctAnswer) {
      questions.push({ question: questionText, options, correctAnswer });
    } else {
      console.warn(`[Quiz] Invalid question format. Question: "${questionText}", Options count: ${options.length}, Correct Answer found: ${!!correctAnswer}`);
    }
  }

  console.log(`[Quiz] Total questions parsed: ${questions.length}`);
  return questions.length >= 3 ? questions.slice(0, 3) : questions;
}

// ================== STATIC FILE SERVING & ROUTING ==================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use('/app', authenticateToken, (req, res, next) => {
  next();
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'home.html'));
});

app.use(express.static(path.join(__dirname)));

async function startServer() {
  try {
    const processes = await findProcess('port', port);
    if (processes.length > 0) {
      console.log(`Port ${port} in use. Killing process...`);
      await killPort(port);
    }
    app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
  } catch (error) {
    console.error('Server Error during startup:', error.message);
    process.exit(1);
  }
}

startServer();

















