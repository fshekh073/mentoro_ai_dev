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
const { exec } = require('child_process');
const fs = require('fs');


// --- DIAGNOSTIC LOG: Check if API key is loaded ---
console.log("OPENAI_API_KEY loaded:", process.env.OPENAI_API_KEY ? "Yes (length: " + process.env.OPENAI_API_KEY.length + ")" : "No");

const app = express();
const port = 5000;

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

  **Required Sections:**
  1. ${sections[0]}: Simple and clear
  2. ${sections[1]}: ${exampleCount} relatable ${langExamples}
  3. ${sections[2]}: ${grade <= 8 ? "Fun fact" : "Scientific principle"}

  **Special Rules:**
  ${instructions}
  ${['Class 9', 'Class 10', 'Class 11', 'Class 12'].includes(grade) ?
    "- Include **bold** technical terms\n- Add relevant formulas\n- Connect to real-world applications" :
    "- Use simple analogies and fun examples"}

  **Example Output:**
  "${greeting}"

  ${sections[0]}:
  [Clear ${language} definition]

  ${sections[1]}:
  ${grade <= 5 ?
    "1) [Child-friendly example 1]\n2) [Example 2]" :
    "1) [NCERT-style example]\n2) [Real-world application]\n3) [Additional example]"
  }

  ${sections[2]}:
  [${grade <= 8 ? "Interesting fact" : "Key scientific principle"}]
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

  // 🔒 Fallback for empty topics
  if (!weakTopics || weakTopics.length === 0) {
    return `
You are an expert AI tutor for ${studentGrade} students in India.

🧠 The student has no recent weak topics identified.

📋 Please create a general 5-day revision plan for ${studentGrade} covering important concepts.

Follow this structure:

### 🗓 Day X: [Topic Name]
- **🧠 Why You Should Revise This**
- **✅ Steps to Master It**
- **📘 Study Resources**
- **❓ Practice Question**
- **💡 Fun Tip**

✅ Use markdown formatting with emojis and spacing.  
✅ Language: ${langInstruction}  
✅ Tone: ${tone}
    `.trim();
  }

  // ✅ Safely build topics string (prevent NaN)
  const topicsString = weakTopics.map(topic => {
    const score = Number.isFinite(topic.score) ? topic.score : 0;
    return `- ${topic.question} (score: ${score}/3)`;
  }).join('\n');

  // ✅ Main personalized prompt
  return `
You are an expert AI tutor creating a highly engaging and visually clear 5-day personalized learning plan for a ${studentGrade} student in India.

🎯 **Student's Weak Topics:**
${topicsString}

📋 **Your Task:**
Design a 5-day plan to improve these topics. For each day, focus on one topic and include the following sections:

---

### 🗓 **Day X: [Topic Name]**

**🧠 Why You Struggled:**  
Short explanation of common difficulties

**✅ Step-by-Step Improvement Plan:**  
List 3–5 clear, simple steps using:
- 📚 Reading
- 🎥 Watching videos
- ✍️ Practice tasks

**📘 Best Study Material:**  
Mention specific NCERT chapters or free online content

**❓ Practice Question:**  
Multiple-choice question with 4 options (mark correct with *)

**💡 Fun Fact or Tip:**  
Creative or memorable fact to help retention

---

📦 **Instructions:**
- Format output in **Markdown**
- Include **emojis** at the start of each section
- Add **line breaks** between sections for readability
- Use friendly and motivating tone: ${tone}
- Language: ${langInstruction}
- Distribute 1 topic per day (5 days)

✅ If no weak topics exist, fallback to a general revision plan for ${studentGrade}.
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

// Replace the existing /api/personalized-plan endpoint in server.js with this fixed version:

app.post('/api/personalized-plan', authenticateToken, async (req, res) => {
  const user_id = req.user?.id;
  const studentGrade = req.user?.class || "Class 8";
  const studentLanguage = req.body.language || "English";

  if (!user_id || !studentGrade) {
    return res.status(400).json({ error: 'User ID and student grade are required.' });
  }

  try {
    // Fetch activities first
    const response = await axios.get(
      `${SUPABASE_URL}/rest/v1/student_activity?user_id=eq.${user_id}&select=question,quiz_score,grade,language`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      }
    );

    const activities = response.data;

    if (!activities || activities.length === 0) {
      return res.json({ 
        personalizedPlan: `
# 📚 Welcome to Your Learning Journey!

Since you haven't taken any quizzes yet, here's a general study plan for ${studentGrade}:

## 🗓 Day 1: Mathematics Fundamentals
- **📘 Focus**: Basic arithmetic and problem-solving
- **✅ Activities**: Practice 10 problems daily
- **💡 Tip**: Start with easier problems and gradually increase difficulty

## 🗓 Day 2: Science Concepts
- **📘 Focus**: Basic scientific principles
- **✅ Activities**: Read one chapter from NCERT
- **💡 Tip**: Make notes of key concepts

## 🗓 Day 3: Language Skills
- **📘 Focus**: Reading and comprehension
- **✅ Activities**: Read one story or article
- **💡 Tip**: Summarize what you read

## 🗓 Day 4: Social Studies
- **📘 Focus**: History and geography basics
- **✅ Activities**: Learn about your local area
- **💡 Tip**: Connect history with current events

## 🗓 Day 5: Review and Practice
- **📘 Focus**: Revision of all subjects
- **✅ Activities**: Take practice quizzes
- **💡 Tip**: Focus on areas you find challenging

Start taking quizzes to get a personalized plan based on your performance! 🚀
        `
      });
    }

    // Calculate weak topics
    const topicScores = {};
    activities.forEach(activity => {
      if (!topicScores[activity.question]) {
        topicScores[activity.question] = { totalScore: 0, count: 0 };
      }
      topicScores[activity.question].totalScore += activity.quiz_score;
      topicScores[activity.question].count += 1;
    });

    const weakTopics = [];
    for (const topic in topicScores) {
      const avgScore = topicScores[topic].totalScore / topicScores[topic].count;
      if (avgScore <= 2) {
        weakTopics.push({
          question: topic,
          score: Math.round(avgScore * 10) / 10 // Round to 1 decimal place
        });
      }
    }

    // Build the prompt
    const prompt = buildPersonalizedPlanPrompt(weakTopics, studentGrade, studentLanguage);

    console.log("Sending prompt to OpenAI:", prompt.substring(0, 200) + "...");

    // Call OpenAI API (non-streaming version)
    const openaiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        { 
          role: 'system', 
          content: 'You are a personalized AI tutor. Create engaging, well-structured learning plans with clear formatting using markdown, emojis, and proper spacing for mobile readability.' 
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 2000
    }, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const personalizedPlan = openaiResponse.data.choices[0].message.content;
    
    console.log("OpenAI response received, length:", personalizedPlan.length);

    return res.json({ personalizedPlan });

  } catch (error) {
    console.error("Personalized plan error:", error.response?.data || error.message);
    return res.status(500).json({ 
      error: 'Failed to generate personalized plan. Please try again.',
      details: error.response?.data?.error?.message || error.message
    });
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

app.post('/api/ocr', authenticateToken, async (req, res) => {
  const { image } = req.body;

  if (!image) return res.status(400).json({ error: 'Image data is required.' });
  if (!image.match(/^data:image\/(jpeg|png);base64,/))
    return res.status(400).json({ error: 'Invalid image format. Only JPEG or PNG is supported.' });

  let worker = null;

  try {
    const buffer = Buffer.from(image.replace(/^data:image\/(jpeg|png);base64,/, ''), 'base64');

    // ✅ Preprocess 3 versions: grayscale, color-boost, handwriting-boost
    const [grayBuffer, colorBuffer, handwritingBuffer] = await Promise.all([
      sharp(buffer)
        .resize({ width: 1600, withoutEnlargement: true })
        .grayscale()
        .modulate({ brightness: 1.3, contrast: 1.6 })
        .sharpen()
        .toFormat('png')
        .toBuffer(),

      sharp(buffer)
        .resize({ width: 1600, withoutEnlargement: true })
        .modulate({ brightness: 1.2, contrast: 1.3, saturation: 1.6 })
        .sharpen()
        .toFormat('png')
        .toBuffer(),

      sharp(buffer)
        .resize({ width: 1600, withoutEnlargement: true })
        .modulate({ brightness: 1.5, contrast: 2.0, saturation: 2.0 }) // Boost ink stroke
        .sharpen({ sigma: 1.2 })
        .toFormat('png')
        .toBuffer()
    ]);

    // 🧠 Create worker
    worker = await createWorker('eng', 1, {
      langPath: path.join(__dirname, 'lang-data'),
      oem: 1,
    });

    await worker.setParameters({
      tessedit_pageseg_mode: '11', // Sparse text – better for handwriting
      user_defined_dpi: '450',
      preserve_interword_spaces: '1',
    });

    // 🧪 Run OCR on all versions
    const [grayResult, colorResult, handwritingResult] = await Promise.all([
      worker.recognize(grayBuffer),
      worker.recognize(colorBuffer),
      worker.recognize(handwritingBuffer),
    ]);

    const results = [
      { type: 'gray', ...grayResult.data },
      { type: 'color', ...colorResult.data },
      { type: 'handwriting', ...handwritingResult.data },
    ];

    // 🥇 Pick best based on confidence and length
    results.sort((a, b) => b.confidence - a.confidence || b.text.length - a.text.length);
    const best = results[0];

    console.log("Best OCR Type:", best.type);
    console.log("OCR Confidence:", best.confidence);

    if (best.confidence < 70 || !best.text.trim()) {
      return res.status(400).json({
        error: '🧐 Low OCR confidence. Try again with better lighting and alignment.'
      });
    }

    // 🧹 Clean text
    let cleanedText = best.text
      .replace(/[^\x00-\x7F]/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/[-\u001F]+/g, " ")
      .trim();

    if (!cleanedText) {
      return res.status(400).json({ error: 'No clean text recognized after processing.' });
    }

    // ✅ Spell correction
    const wordsArray = cleanedText.split(/\s+/);
    const correctedWords = wordsArray.map(word => {
      if (spell.isMisspelled(word)) {
        return spell.getCorrectionsForMisspelling(word)[0] || word;
      }
      return word;
    });

    let correctedText = correctedWords.join(' ');
    console.log("Spell-corrected:", correctedText);

    // 🤖 GPT contextual cleanup
    const finalCorrectedText = await correctTextWithGPT(correctedText);
    console.log("GPT-cleaned OCR Text:", finalCorrectedText);

    return res.json({ text: finalCorrectedText });

  } catch (error) {
    console.error('OCR Error:', error.message, error.stack);
    return res.status(500).json({
      error: 'Failed to process OCR. Ensure the image contains clear text and good lighting.',
      details: error.message
    });
  } finally {
    if (worker) await worker.terminate();
  }
});

// ================== EXISTING AI API ENDPOINTS ==================
app.post('/api/explain', authenticateToken, async (req, res) => {
  const { question, grade, language, role } = req.body;
  const userId = req.user?.id;
  const username = req.user?.username;
  const cacheKey = `${question}-${grade}-${language}-${role}`;
  const today = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD

  // 🚫 Sensitive content block
  const lowerQuestion = question.toLowerCase();
  if (SENSITIVE_KEYWORDS.some(k => lowerQuestion.includes(k))) {
    return res.json({ explanation: `⚠️ I can't explain this topic as it may contain sensitive content.` });
  }

  // ✅ Check in-memory cache first
  if (explanationCache.has(cacheKey)) {
    return res.json({ explanation: explanationCache.get(cacheKey) });
  }

  try {
    const isUnlimitedUser = username === 'fshekh'; // 👈 Your bypass condition

    // ✅ 1. Supabase usage check (for normal users only)
    let usageToday = null;
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

      usageToday = data;

      if (usageToday && usageToday.explain_count >= 10) {
        return res.status(429).json({
          error: '🚫 Daily explanation limit reached (10 per day). Please try again tomorrow.'
        });
      }
    }

app.post('/api/explain-coding-topic', async (req, res) => {
  const { language, topic } = req.body;

  if (!language || !topic) {
    return res.status(400).json({ error: 'Missing language or topic' });
  }

  const prompt = `
  Explain the topic "${topic}" in ${language} to a class 6-8 student.
  Use simple, kid-friendly language (max 4 lines).
  Include a short working code example (1–3 lines).
  
  Format:
  Explanation: <brief explanation>
  Code: <short working code>
  `;

  try {
    const chatResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
    });

    const content = chatResponse.choices[0].message.content;

    // Split response into explanation and code
    const match = content.match(/Explanation:(.*?)(?:\\n)?Code:(.*)/s);
    const explanation = match?.[1]?.trim() || content;
    const code = match?.[2]?.trim() || '';

    res.json({ explanation, code });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to get explanation from GPT' });
  }
});

    // ✅ 2. Build prompt and call OpenAI
    const prompt = buildExplanationPrompt(question, grade, language, role);

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is not defined.");
      return res.status(500).json({ error: "Server configuration error: OpenAI API key is missing." });
    }

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          {
            role: "system",
            content: "You are a helpful AI tutor who adapts explanations perfectly to grade level."
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.7,
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    const explanation = formatResponse(response.data.choices[0].message.content, grade);

    // ✅ 3. Store to in-memory cache
    explanationCache.set(cacheKey, explanation);

    // ✅ 4. Increment Supabase usage count (only for normal users)
    if (!isUnlimitedUser) {
      if (usageToday) {
        await supabase
          .from('usage_limits')
          .update({ explain_count: usageToday.explain_count + 1 })
          .eq('user_id', userId)
          .eq('date', today);
      } else {
        await supabase
          .from('usage_limits')
          .insert([{ user_id: userId, date: today, explain_count: 1 }]);
      }
    } else {
      console.log(`✅ Unlimited usage for user: ${username}`);
    }

    return res.json({ explanation });
  } catch (error) {
    console.error('Explanation Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to generate explanation. Please try again.' });
  }
});

//const configuration = new Configuration({
//  apiKey: process.env.OPENAI_API_KEY
//});
//const openai = new OpenAIApi(configuration);

app.post('/api/quiz', authenticateToken, async (req, res) => {
  const { question, explanation, grade, language } = req.body;
  const cacheKey = `${question}-${grade}-${language}-quiz`;

  console.log(`[Quiz Log] Received quiz request for topic: "${question}" (Grade: ${grade}, Language: ${language})`);

  if (quizCache.has(cacheKey)) {
    console.log(`[Quiz Log] Returning quiz from cache for topic: "${question}"`);
    return res.json({ questions: quizCache.get(cacheKey) });
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
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    const rawQuizResponse = response.data.choices[0].message.content;
    console.log('[Quiz Log] Raw response from LLM for quiz:', rawQuizResponse);

    const parsedQuestions = parseQuiz(rawQuizResponse);
    quizCache.set(cacheKey, parsedQuestions);

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
