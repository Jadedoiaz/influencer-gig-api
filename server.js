const express = require('express');
const cors = require('cors');
const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const bcryptjs = require('bcryptjs');
const sgMail = require('@sendgrid/mail');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// ===== MIDDLEWARE =====
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ===== AUTH ENDPOINTS =====
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, username, displayName, password } = req.body;

    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Email, username, and password are required' });
    }

    const existingRecords = await base('Influencers').select({
      filterByFormula: `{Email} = '${email}'`,
      maxRecords: 1
    }).firstPage();

    if (existingRecords.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcryptjs.hash(password, 10);
    const verificationToken = Math.random().toString(36).substr(2, 9);

    const record = await base('Influencers').create({
      Email: email,
      Username: username,
      'Display Name': displayName || username,
      'Password Hash': hashedPassword,
      'Verification Token': verificationToken,
      'Verification Status': 'Pending'
    });

    const verificationLink = `${process.env.FRONTEND_URL || 'https://www.influencergigs.xyz'}/verify?token=${verificationToken}&email=${email}`;

    await sgMail.send({
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: 'Verify Your InfluencerGig Account',
      html: `
        <h2>Welcome to InfluencerGig!</h2>
        <p>Click the link below to verify your email:</p>
        <a href="${verificationLink}">Verify Email</a>
        <p>Or copy this link: ${verificationLink}</p>
      `
    });

    res.json({ message: 'Signup successful. Check your email to verify.' });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const { email, token } = req.body;

    const records = await base('Influencers').select({
      filterByFormula: `{Email} = '${email}'`,
      maxRecords: 1
    }).firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const record = records[0];
    if (record.fields['Verification Token'] !== token) {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    await base('Influencers').update(record.id, {
      'Verification Status': 'Verified'
    });

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    console.error('Verify error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const records = await base('Influencers').select({
      filterByFormula: `{Email} = '${email}'`,
      maxRecords: 1
    }).firstPage();

    if (records.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const record = records[0];

    if (record.fields['Verification Status'] !== 'Verified') {
      return res.status(401).json({ error: 'Please verify your email first' });
    }

    const isPasswordValid = await bcryptjs.compare(password, record.fields['Password Hash']);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { email: email, userId: record.id, isAdmin: record.fields['Is Admin'] || false },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        email: email,
        username: record.fields.Username,
        displayName: record.fields['Display Name'],
        isAdmin: record.fields['Is Admin'] || false
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const records = await base('Influencers').select({
      filterByFormula: `{Email} = '${req.user.email}'`,
      maxRecords: 1
    }).firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const record = records[0];
    res.json({
      email: record.fields.Email,
      username: record.fields.Username,
      displayName: record.fields['Display Name'],
      isAdmin: record.fields['Is Admin'] || false,
      stripeAccountId: record.fields['Stripe Account ID']
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ADMIN ENDPOINTS =====
app.post('/api/admin/set-admin', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Invalid admin key' });
    }

    const { email } = req.body;
    const records = await base('Influencers').select({
      filterByFormula: `{Email} = '${email}'`,
      maxRecords: 1
    }).firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await base('Influencers').update(records[0].id, { 'Is Admin': true });
    res.json({ message: 'User promoted to admin' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== SUBMISSION ENDPOINTS =====
app.post('/api/submit-content', authenticateToken, async (req, res) => {
  try {
    const { productId, videoUrl, caption } = req.body;

    if (!productId || !videoUrl) {
      return res.status(400).json({ error: 'Product and video URL are required' });
    }

    const influencers = await base('Influencers').select({
      filterByFormula: `{Email} = '${req.user.email}'`,
      maxRecords: 1
    }).firstPage();

    if (influencers.length === 0) {
      return res.status(404).json({ error: 'Influencer not found' });
    }

    const influencerId = influencers[0].id;
    const submissionId = 'SUB-' + Date.now();

    const record = await base('Submissions').create({
      'Submission ID': submissionId,
      'Video URL': videoUrl,
      'Caption': caption || '',
      'Submission Date': new Date().toISOString().split('T')[0],
      'Status': 'Pending',
      'Influencer': [influencerId],
      'Product': [productId]
    });

    res.json({
      message: 'Content submitted successfully',
      submissionId: submissionId,
      recordId: record.id
    });
  } catch (error) {
    console.error('Submit content error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/my-submissions', authenticateToken, async (req, res) => {
  try {
    const influencers = await base('Influencers').select({
      filterByFormula: `{Email} = '${req.user.email}'`,
      maxRecords: 1
    }).firstPage();

    if (influencers.length === 0) {
      return res.json([]);
    }

    const influencerId = influencers[0].id;
    const allSubmissions = await base('Submissions').select().all();

    const mySubmissions = allSubmissions
      .filter(record => {
        const linked = record.fields['Influencer'];
        return linked && linked.includes(influencerId);
      })
      .map(record => ({
        id: record.id,
        ...record.fields
      }));

    res.json(mySubmissions);
  } catch (error) {
    console.error('My submissions error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== STRIPE CONNECT ENDPOINTS =====

// Admin approves submission with reward amount
app.post('/api/admin/approve-submission', authenticateToken, async (req, res) => {
  try {
    const { submissionId, rewardAmount } = req.body;

    // Check if admin
    const adminRecords = await base('Influencers').select({
      filterByFormula: `{Email} = '${req.user.email}'`,
      maxRecords: 1
    }).firstPage();

    if (adminRecords.length === 0 || !adminRecords[0].fields['Is Admin']) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Find the submission by its record ID
    let submission;
    try {
      submission = await base('Submissions').find(submissionId);
    } catch (findErr) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const influencerId = submission.fields['Influencer'][0];

    // Get influencer details by record ID
    const influencer = await base('Influencers').find(influencerId);
    const stripeAccountId = influencer.fields['Stripe Account ID'];

    if (!stripeAccountId) {
      return res.status(400).json({ error: 'Creator does not have a Stripe account connected' });
    }

    // Update submission status
    await base('Submissions').update(submissionId, {
      'Status': 'Approved',
      'Reward Amount': rewardAmount
    });

    // Create payout record
    const payoutId = 'PAYOUT-' + Date.now();
    const payoutRecord = await base('Payouts').create({
      'Payout ID': payoutId,
      'Total Amount': rewardAmount,
      'Status': 'Processing',
      'Payout Date': new Date().toISOString().split('T')[0],
      'Influencer': [influencerId]
    });

    // Transfer funds to creator via Stripe Connect
    try {
      const transfer = await stripe.transfers.create({
        amount: Math.round(rewardAmount * 100), // Convert to cents
        currency: 'usd',
        destination: stripeAccountId,
        description: `InfluencerGig payout for submission ${submission.fields['Submission ID']}`
      });

      // Update payout with Stripe transaction ID
      await base('Payouts').update(payoutRecord.id, {
        'Status': 'Completed',
        'Stripe Transaction ID': transfer.id
      });

      // Send email to creator
      await sgMail.send({
        to: influencer.fields.Email,
        from: process.env.SENDGRID_FROM_EMAIL,
        subject: 'You\'ve Earned a Payout! 💰',
        html: `
          <h2>Great news!</h2>
          <p>Your submission has been approved and you've earned <strong>$${rewardAmount.toFixed(2)}</strong>!</p>
          <p>The funds will be transferred to your connected Stripe account within 1-2 business days.</p>
          <p><a href="${process.env.FRONTEND_URL}/dashboard">View your dashboard</a></p>
        `
      });

      res.json({
        message: 'Submission approved and payout processed',
        payoutId: payoutId,
        transferId: transfer.id
      });
    } catch (stripeError) {
      // If Stripe transfer fails, mark as failed
      await base('Payouts').update(payoutRecord.id, {
        'Status': 'Failed'
      });

      console.error('Stripe transfer error:', stripeError);
      res.status(500).json({ error: 'Payment processing failed: ' + stripeError.message });
    }
  } catch (error) {
    console.error('Approve submission error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reject submission
app.post('/api/admin/reject-submission', authenticateToken, async (req, res) => {
  try {
    const { submissionId, adminNotes } = req.body;

    // Check if admin
    const adminRecords = await base('Influencers').select({
      filterByFormula: `{Email} = '${req.user.email}'`,
      maxRecords: 1
    }).firstPage();

    if (adminRecords.length === 0 || !adminRecords[0].fields['Is Admin']) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Find submission by its record ID
    let submission;
    try {
      submission = await base('Submissions').find(submissionId);
    } catch (findErr) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Update submission status
    await base('Submissions').update(submissionId, {
      'Status': 'Rejected',
      'Admin Notes': adminNotes || ''
    });

    // Get influencer and send notification
    const influencerId = submission.fields['Influencer'][0];
    const influencer = await base('Influencers').find(influencerId);

    await sgMail.send({
      to: influencer.fields.Email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: 'Submission Update',
      html: `
        <h2>Submission Status Update</h2>
        <p>Your submission has been reviewed and rejected.</p>
        ${adminNotes ? `<p><strong>Feedback:</strong> ${adminNotes}</p>` : ''}
        <p><a href="${process.env.FRONTEND_URL}/dashboard">View your dashboard</a></p>
      `
    });

    res.json({ message: 'Submission rejected' });
  } catch (error) {
    console.error('Reject submission error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all submissions (admin only)
app.get('/api/submissions', authenticateToken, async (req, res) => {
  try {
    const adminRecords = await base('Influencers').select({
      filterByFormula: `{Email} = '${req.user.email}'`,
      maxRecords: 1
    }).firstPage();

    if (adminRecords.length === 0 || !adminRecords[0].fields['Is Admin']) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const submissions = await base('Submissions').select().all();
    const formattedSubmissions = submissions.map(record => ({
      id: record.id,
      ...record.fields
    }));

    res.json(formattedSubmissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get products
app.get('/api/products', async (req, res) => {
  try {
    const products = await base('Products').select({
      fields: ['Product Name', 'ASIN', 'Price', 'Image URL', 'Affiliate Link', 'Category']
    }).all();

    const formattedProducts = products.map(record => ({
      id: record.id,
      ...record.fields
    }));

    res.json(formattedProducts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
