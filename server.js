const express = require('express');
const cors = require('cors');
const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sgMail = require('@sendgrid/mail');

const app = express();
app.use(cors());
app.use(express.json());

// ===== SETUP =====
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const JWT_EXPIRY = '7d';

// ===== MIDDLEWARE =====
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ===== AUTH ENDPOINTS =====

// Register new influencer
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, username, displayName, niche, password } = req.body;

    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Email, username, and password required' });
    }

    // Check if email exists
    const existing = await base('Influencers').select({
      filterByFormula: `{Email} = '${email}'`
    }).firstPage();

    if (existing.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate verification token
    const verificationToken = Math.random().toString(36).substring(2, 15);

    // Create record
    const record = await base('Influencers').create({
      Email: email,
      Username: username,
      'Display Name': displayName || username,
      Niche: niche,
      'Password Hash': hashedPassword,
      'Verification Token': verificationToken,
      'Verification Status': 'Pending',
      'Is Admin': false
    });

    // Send verification email
    const verificationLink = `${process.env.FRONTEND_URL || 'https://www.influencergigs.xyz'}/verify?token=${verificationToken}&email=${email}`;

    await sgMail.send({
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL || 'hello@influencergigs.xyz',
      subject: '📧 Verify Your InfluencerGig Account',
      html: `
        <h2>Welcome to InfluencerGig! 🎬</h2>
        <p>Click below to verify your account:</p>
        <a href="${verificationLink}" style="padding: 12px 24px; background: #7c3aed; color: white; text-decoration: none; border-radius: 6px;">Verify Account</a>
        <p>Or copy this link: ${verificationLink}</p>
        <p>This link expires in 24 hours.</p>
      `
    });

    res.status(201).json({ 
      message: 'Signup successful! Check your email to verify.',
      recordId: record.id
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Find influencer
    const records = await base('Influencers').select({
      filterByFormula: `{Email} = '${email}'`
    }).firstPage();

    if (records.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const influencer = records[0];
    const passwordHash = influencer.fields['Password Hash'];

    if (!passwordHash) {
      return res.status(401).json({ error: 'Account not setup. Please contact support.' });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if verified
    if (influencer.fields['Verification Status'] !== 'Verified') {
      return res.status(403).json({ error: 'Please verify your email first' });
    }

    // Generate JWT
    const token = jwt.sign(
      {
        id: influencer.id,
        email: influencer.fields.Email,
        username: influencer.fields.Username,
        isAdmin: influencer.fields['Is Admin'] || false
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.json({
      token,
      user: {
        id: influencer.id,
        email: influencer.fields.Email,
        username: influencer.fields.Username,
        displayName: influencer.fields['Display Name'],
        isAdmin: influencer.fields['Is Admin'] || false
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify email
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { email, token } = req.body;

    const records = await base('Influencers').select({
      filterByFormula: `{Email} = '${email}'`
    }).firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const influencer = records[0];

    if (influencer.fields['Verification Token'] !== token) {
      return res.status(401).json({ error: 'Invalid verification token' });
    }

    // Mark as verified
    await base('Influencers').update(influencer.id, {
      'Verification Status': 'Verified'
    });

    res.json({ message: 'Email verified! You can now login.' });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current user
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const record = await base('Influencers').find(req.user.id);
    res.json({
      id: record.id,
      email: record.fields.Email,
      username: record.fields.Username,
      displayName: record.fields['Display Name'],
      isAdmin: record.fields['Is Admin'] || false
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ADMIN ENDPOINTS =====

// Get all submissions (admin only)
app.get('/api/submissions', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const records = await base('Submissions').select().all();
    const submissions = records.map(record => ({
      id: record.id,
      ...record.fields
    }));
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve submission (admin only)
app.post('/api/admin/approve-submission', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { submissionId, rewardAmount } = req.body;

    await base('Submissions').update(submissionId, {
      Status: 'Approved',
      'Reward Amount': rewardAmount,
      'Paid': false
    });

    res.json({ message: 'Submission approved!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reject submission (admin only)
app.patch('/api/submissions/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { Status } = req.body;
    await base('Submissions').update(req.params.id, { Status });
    res.json({ message: 'Submission updated!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set admin status (super admin only - hardcoded check)
app.post('/api/admin/set-admin', authenticateToken, async (req, res) => {
  try {
    const { influencerId, isAdmin } = req.body;
    const adminPassword = req.headers['x-admin-key'];

    // Simple admin key validation (in production, use different approach)
    if (adminPassword !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Admin key required' });
    }

    await base('Influencers').update(influencerId, {
      'Is Admin': isAdmin
    });

    res.json({ message: `User ${isAdmin ? 'promoted' : 'demoted'}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== PRODUCTS ENDPOINT =====
app.get('/api/products', async (req, res) => {
  try {
    const records = await base('Products').select().all();
    const products = records.map(record => ({
      id: record.id,
      ...record.fields
    }));
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Auth server running on port ${PORT}`);
});
