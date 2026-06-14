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
      'Status': stripeAccountId ? 'Processing' : 'Pending',
      'Payout Date': new Date().toISOString().split('T')[0],
      'Notes': stripeAccountId ? '' : 'Creator has no Stripe account yet - payout pending',
      'Influencer': [influencerId]
    });

    // If creator has Stripe account, transfer funds
    if (stripeAccountId) {
      try {
        const transfer = await stripe.transfers.create({
          amount: Math.round(rewardAmount * 100),
          currency: 'usd',
          destination: stripeAccountId,
          description: `InfluencerGig payout for submission ${submission.fields['Submission ID']}`
        });

        await base('Payouts').update(payoutRecord.id, {
          'Status': 'Completed',
          'Stripe Transaction ID': transfer.id
        });

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
        await base('Payouts').update(payoutRecord.id, {
          'Status': 'Failed',
          'Notes': 'Stripe transfer failed: ' + stripeError.message
        });

        console.error('Stripe transfer error:', stripeError);
        res.status(500).json({ error: 'Payment processing failed: ' + stripeError.message });
      }
    } else {
      // No Stripe account - approve but hold payout
      await sgMail.send({
        to: influencer.fields.Email,
        from: process.env.SENDGRID_FROM_EMAIL,
        subject: 'Your Submission was Approved! ✅',
        html: `
          <h2>Great news!</h2>
          <p>Your submission has been approved and you've earned <strong>$${rewardAmount.toFixed(2)}</strong>!</p>
          <p>To receive your payout, please connect your Stripe account in your dashboard.</p>
          <p><a href="${process.env.FRONTEND_URL}/dashboard">View your dashboard</a></p>
        `
      });

      res.json({
        message: 'Submission approved! Payout pending - creator needs to connect Stripe account.',
        payoutId: payoutId
      });
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

// ===== FORGOT PASSWORD =====
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    const records = await base('Influencers').select({
      filterByFormula: `{Email} = '${email}'`,
      maxRecords: 1
    }).firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const record = records[0];
    const resetToken = Math.random().toString(36).substr(2, 9);

    // Save reset token
    await base('Influencers').update(record.id, {
      'Reset Token': resetToken,
      'Reset Token Expires': new Date(Date.now() + 3600000).toISOString()
    });

    const resetLink = `${process.env.FRONTEND_URL || 'https://www.influencergigs.xyz'}/reset-password?token=${resetToken}&email=${email}`;

    await sgMail.send({
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: 'Reset Your InfluencerGig Password',
      html: `
        <h2>Password Reset Request</h2>
        <p>Click the link below to reset your password:</p>
        <a href="${resetLink}">Reset Password</a>
        <p>Or copy this link: ${resetLink}</p>
        <p><small>This link expires in 1 hour</small></p>
      `
    });

    res.json({ message: 'Reset link sent to your email' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== RESET PASSWORD =====
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const records = await base('Influencers').select({
      filterByFormula: `{Email} = '${email}'`,
      maxRecords: 1
    }).firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const record = records[0];
    const storedToken = record.fields['Reset Token'];
    const tokenExpiry = record.fields['Reset Token Expires'];

    if (storedToken !== token || !tokenExpiry || new Date(tokenExpiry) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const hashedPassword = await bcryptjs.hash(newPassword, 10);

    await base('Influencers').update(record.id, {
      'Password Hash': hashedPassword,
      'Reset Token': '',
      'Reset Token Expires': ''
    });

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== ADMIN SET PASSWORD FOR CREATOR =====
app.post('/api/admin/set-creator-password', authenticateToken, async (req, res) => {
  try {
    const { creatorEmail, newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if admin
    const adminRecords = await base('Influencers').select({
      filterByFormula: `{Email} = '${req.user.email}'`,
      maxRecords: 1
    }).firstPage();

    if (adminRecords.length === 0 || !adminRecords[0].fields['Is Admin']) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Find creator
    const creatorRecords = await base('Influencers').select({
      filterByFormula: `{Email} = '${creatorEmail}'`,
      maxRecords: 1
    }).firstPage();

    if (creatorRecords.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    const creator = creatorRecords[0];
    const hashedPassword = await bcryptjs.hash(newPassword, 10);

    await base('Influencers').update(creator.id, {
      'Password Hash': hashedPassword
    });

    res.json({ 
      message: 'Password set successfully',
      creatorEmail: creatorEmail
    });
  } catch (error) {
    console.error('Set password error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== CREATE TEST STRIPE ACCOUNT =====
app.post('/api/admin/create-test-stripe-account', authenticateToken, async (req, res) => {
  try {
    const { creatorEmail } = req.body;

    if (!creatorEmail) {
      return res.status(400).json({ error: 'Creator email is required' });
    }

    // Check if admin
    const adminRecords = await base('Influencers').select({
      filterByFormula: `{Email} = '${req.user.email}'`,
      maxRecords: 1
    }).firstPage();

    if (adminRecords.length === 0 || !adminRecords[0].fields['Is Admin']) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Find the creator
    const creatorRecords = await base('Influencers').select({
      filterByFormula: `{Email} = '${creatorEmail}'`,
      maxRecords: 1
    }).firstPage();

    if (creatorRecords.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    const creatorRecord = creatorRecords[0];
    const creatorId = creatorRecord.id;

    // Create Stripe Connect test account
    try {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: creatorEmail,
        capabilities: {
          transfers: { requested: true }
        }
      });

      const stripeAccountId = account.id;

      // Save the account ID to Airtable
      await base('Influencers').update(creatorId, {
        'Stripe Account ID': stripeAccountId
      });

      // Send confirmation email
      await sgMail.send({
        to: creatorEmail,
        from: process.env.SENDGRID_FROM_EMAIL,
        subject: 'Your Stripe Account is Ready! 💳',
        html: `
          <h2>Welcome to Payouts!</h2>
          <p>Your Stripe Express account has been created and is ready to receive payouts.</p>
          <p>Account ID: <code>${stripeAccountId}</code></p>
          <p>When your submissions are approved, funds will automatically transfer to this account.</p>
          <p><a href="${process.env.FRONTEND_URL}/dashboard">Go to Dashboard</a></p>
        `
      });

      res.json({
        message: 'Stripe test account created successfully',
        stripeAccountId: stripeAccountId,
        creatorEmail: creatorEmail
      });
    } catch (stripeErr) {
      console.error('Stripe account creation error:', stripeErr);
      res.status(500).json({ error: 'Failed to create Stripe account: ' + stripeErr.message });
    }
  } catch (error) {
    console.error('Create account error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/my-payouts', authenticateToken, async (req, res) => {
  try {
    const influencers = await base('Influencers').select({
      filterByFormula: `{Email} = '${req.user.email}'`,
      maxRecords: 1
    }).firstPage();

    if (influencers.length === 0) {
      return res.json([]);
    }

    const influencerId = influencers[0].id;
    const allPayouts = await base('Payouts').select().all();

    const myPayouts = allPayouts
      .filter(record => {
        const linked = record.fields['Influencer'];
        return linked && linked.includes(influencerId);
      })
      .map(record => ({
        id: record.id,
        ...record.fields
      }));

    res.json(myPayouts);
  } catch (error) {
    console.error('My payouts error:', error);
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
      fields: ['Product Name', 'ASIN', 'Price', 'Image URL', 'Affiliate Link', 'Category', 'Content Brief', 'Key Selling Points', 'Post Platforms', 'Reward Amount', 'Submissions']
    }).all();

    const formattedProducts = products.map(record => ({
      id: record.id,
      ...record.fields,
      submissionCount: record.fields['Submissions'] ? record.fields['Submissions'].length : 0
    }));

    res.json(formattedProducts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== WEEKLY PRODUCT EMAIL =====
app.post('/api/admin/send-weekly-email', authenticateToken, async (req, res) => {
  try {
    // Admin only
    const adminRecords = await base('Influencers').select({
      filterByFormula: `{Email} = '${req.user.email}'`,
      maxRecords: 1
    }).firstPage();

    if (adminRecords.length === 0 || !adminRecords[0].fields['Is Admin']) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Get all verified creators
    const creators = await base('Influencers').select({
      filterByFormula: `{Verification Status} = 'Verified'`
    }).all();

    if (creators.length === 0) {
      return res.json({ message: 'No verified creators to email', sent: 0 });
    }

    // Get newest products (last 7 days or top 6 if none new)
    const allProducts = await base('Products').select({
      fields: ['Product Name', 'Price', 'Image URL', 'Affiliate Link', 'Category', 'Reward Amount', 'Added Date'],
      sort: [{ field: 'Added Date', direction: 'desc' }],
      maxRecords: 6
    }).all();

    if (allProducts.length === 0) {
      return res.json({ message: 'No products found', sent: 0 });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://www.influencergigs.xyz';
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // Build product rows for email
    const productRows = allProducts.map(p => {
      const name = p.fields['Product Name'] || 'Product';
      const price = p.fields['Price'] ? `$${p.fields['Price'].toFixed(2)}` : '';
      const reward = p.fields['Reward Amount'] ? `$${p.fields['Reward Amount'].toFixed(2)}` : 'TBD';
      const image = p.fields['Image URL'] || '';
      const category = p.fields['Category'] ? (typeof p.fields['Category'] === 'object' ? p.fields['Category'].name : p.fields['Category']) : '';

      return `
        <tr>
          <td style="padding: 16px; border-bottom: 1px solid #e5e7eb; vertical-align: middle;">
            ${image ? `<img src="${image}" alt="${name}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 6px;" />` : '<div style="width:60px;height:60px;background:#f3f4f6;border-radius:6px;"></div>'}
          </td>
          <td style="padding: 16px; border-bottom: 1px solid #e5e7eb; vertical-align: middle;">
            <p style="font-size: 14px; font-weight: 600; color: #111827; margin: 0 0 4px;">${name}</p>
            ${category ? `<span style="font-size: 11px; color: #6b7280; background: #f3f4f6; padding: 2px 8px; border-radius: 10px;">${category}</span>` : ''}
            ${price ? `<p style="font-size: 13px; color: #6b7280; margin: 4px 0 0;">Price: ${price}</p>` : ''}
          </td>
          <td style="padding: 16px; border-bottom: 1px solid #e5e7eb; vertical-align: middle; text-align: center;">
            <p style="font-size: 20px; font-weight: 800; color: #7c3aed; margin: 0;">${reward}</p>
            <p style="font-size: 11px; color: #6b7280; margin: 2px 0 0;">reward</p>
          </td>
          <td style="padding: 16px; border-bottom: 1px solid #e5e7eb; vertical-align: middle; text-align: center;">
            <a href="${frontendUrl}/dashboard" style="display: inline-block; padding: 8px 16px; background: #7c3aed; color: #fff; text-decoration: none; border-radius: 6px; font-size: 12px; font-weight: 600;">Create Video</a>
          </td>
        </tr>
      `;
    }).join('');

    const emailHtml = `
      <div style="font-family: system-ui, sans-serif; max-width: 640px; margin: 0 auto; color: #111827;">

        <!-- Header -->
        <div style="background: linear-gradient(135deg, #7c3aed, #5b21b6); padding: 32px 24px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: #fff; font-size: 24px; margin: 0 0 8px;">🎬 This Week on InfluencerGig</h1>
          <p style="color: rgba(255,255,255,0.85); font-size: 14px; margin: 0;">${today}</p>
        </div>

        <!-- Intro -->
        <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-top: none; padding: 24px;">
          <p style="font-size: 15px; color: #374151; margin: 0;">Hey Creator! 👋 Here are the latest products available on InfluencerGig this week. Pick one you love, follow the content brief, and submit your video to earn your reward.</p>
        </div>

        <!-- Products Table -->
        <div style="background: #fff; border: 1px solid #e5e7eb; border-top: none;">
          <div style="padding: 20px 24px 8px; border-bottom: 1px solid #e5e7eb;">
            <h2 style="font-size: 16px; font-weight: 700; color: #111827; margin: 0;">🛍️ Products Available Now</h2>
          </div>
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background: #f9fafb;">
                <th style="padding: 10px 16px; text-align: left; font-size: 11px; color: #6b7280; text-transform: uppercase; font-weight: 600;"></th>
                <th style="padding: 10px 16px; text-align: left; font-size: 11px; color: #6b7280; text-transform: uppercase; font-weight: 600;">Product</th>
                <th style="padding: 10px 16px; text-align: center; font-size: 11px; color: #6b7280; text-transform: uppercase; font-weight: 600;">Your Reward</th>
                <th style="padding: 10px 16px; text-align: center; font-size: 11px; color: #6b7280; text-transform: uppercase; font-weight: 600;"></th>
              </tr>
            </thead>
            <tbody>
              ${productRows}
            </tbody>
          </table>
        </div>

        <!-- CTA -->
        <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-top: none; padding: 24px; text-align: center;">
          <p style="font-size: 14px; color: #6b7280; margin: 0 0 16px;">Browse all 51+ products on the marketplace</p>
          <a href="${frontendUrl}/marketplace" style="display: inline-block; padding: 14px 32px; background: #7c3aed; color: #fff; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 700;">View Full Marketplace →</a>
        </div>

        <!-- Tips -->
        <div style="background: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 0 0 10px 10px; padding: 20px 24px;">
          <h3 style="font-size: 13px; font-weight: 700; color: #7c3aed; margin: 0 0 10px; text-transform: uppercase;">💡 Quick Reminder</h3>
          <ul style="font-size: 13px; color: #374151; padding-left: 18px; margin: 0; line-height: 1.8;">
            <li>Put the affiliate link in your bio <strong>before</strong> posting</li>
            <li>Follow the content brief closely for faster approval</li>
            <li>End every video with the call to action from the brief</li>
            <li>Most submissions are approved within 24 hours</li>
          </ul>
        </div>

        <!-- Footer -->
        <div style="padding: 20px 24px; text-align: center;">
          <p style="font-size: 12px; color: #9ca3af; margin: 0;">© 2026 InfluencerGig · <a href="${frontendUrl}/dashboard" style="color: #7c3aed;">Your Dashboard</a> · <a href="https://www.influencergig.online" style="color: #7c3aed;">Home</a></p>
        </div>
      </div>
    `;

    // Send to all verified creators
    let sent = 0;
    let failed = 0;

    for (const creator of creators) {
      const email = creator.fields.Email;
      const name = creator.fields['Display Name'] || creator.fields.Username || 'Creator';
      if (!email) continue;

      try {
        await sgMail.send({
          to: email,
          from: process.env.SENDGRID_FROM_EMAIL,
          subject: `🎬 New Products This Week — Up to $50 Per Video`,
          html: emailHtml.replace('Hey Creator! 👋', `Hey ${name}! 👋`)
        });
        sent++;
      } catch (emailErr) {
        console.error(`Failed to send to ${email}:`, emailErr.message);
        failed++;
      }
    }

    res.json({
      message: `Weekly email sent successfully`,
      sent,
      failed,
      total: creators.length
    });
  } catch (error) {
    console.error('Weekly email error:', error);
    res.status(500).json({ error: error.message });
  }
});


app.post('/api/send-brief', authenticateToken, async (req, res) => {
  try {
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({ error: 'Product ID is required' });
    }

    // Get creator info
    const creators = await base('Influencers').select({
      filterByFormula: `{Email} = '${req.user.email}'`,
      maxRecords: 1
    }).firstPage();

    if (creators.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    const creator = creators[0];

    // Get product info
    const product = await base('Products').find(productId);
    const fields = product.fields;

    const productName = fields['Product Name'] || 'Product';
    const affiliateLink = fields['Affiliate Link'] || '';
    const contentBrief = fields['Content Brief'] || 'Create an authentic video reviewing this product.';
    const keyPoints = fields['Key Selling Points'] || '';
    const platforms = fields['Post Platforms'] ? fields['Post Platforms'].map(p => p.name || p).join(', ') : 'TikTok, Instagram Reels';
    const rewardAmount = fields['Reward Amount'] ? `$${fields['Reward Amount'].toFixed(2)}` : 'TBD';
    const price = fields['Price'] ? `$${fields['Price'].toFixed(2)}` : '';
    const imageUrl = fields['Image URL'] || '';

    await sgMail.send({
      to: creator.fields.Email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: `📋 Your Content Brief: ${productName}`,
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111827;">
          <div style="background: #7c3aed; padding: 24px; border-radius: 10px 10px 0 0; text-align: center;">
            <h1 style="color: #fff; margin: 0; font-size: 22px;">Your Content Brief</h1>
            <p style="color: #e9d5ff; margin: 8px 0 0; font-size: 14px;">Everything you need to create great content</p>
          </div>

          <div style="background: #fff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px; padding: 24px;">

            ${imageUrl ? `<div style="text-align: center; margin-bottom: 20px;"><img src="${imageUrl}" alt="${productName}" style="max-width: 200px; border-radius: 8px;" /></div>` : ''}

            <h2 style="font-size: 18px; color: #111827; margin-bottom: 4px;">${productName}</h2>
            ${price ? `<p style="color: #6b7280; font-size: 14px; margin-bottom: 16px;">Price: ${price}</p>` : ''}

            <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
              <h3 style="font-size: 14px; font-weight: 700; color: #374151; margin-bottom: 8px; text-transform: uppercase;">💰 Your Reward</h3>
              <p style="font-size: 24px; font-weight: bold; color: #7c3aed; margin: 0;">${rewardAmount}</p>
              <p style="font-size: 12px; color: #6b7280; margin: 4px 0 0;">Paid upon approval of your submission</p>
            </div>

            <div style="margin-bottom: 20px;">
              <h3 style="font-size: 14px; font-weight: 700; color: #374151; margin-bottom: 8px; text-transform: uppercase;">📹 Content Brief</h3>
              <p style="font-size: 14px; color: #374151; line-height: 1.6; white-space: pre-line;">${contentBrief}</p>
            </div>

            ${keyPoints ? `
            <div style="margin-bottom: 20px;">
              <h3 style="font-size: 14px; font-weight: 700; color: #374151; margin-bottom: 8px; text-transform: uppercase;">✅ Key Selling Points</h3>
              <p style="font-size: 14px; color: #374151; line-height: 1.6; white-space: pre-line;">${keyPoints}</p>
            </div>` : ''}

            <div style="margin-bottom: 20px;">
              <h3 style="font-size: 14px; font-weight: 700; color: #374151; margin-bottom: 8px; text-transform: uppercase;">📱 Where to Post</h3>
              <p style="font-size: 14px; color: #374151;">${platforms}</p>
            </div>

            ${affiliateLink ? `
            <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
              <h3 style="font-size: 14px; font-weight: 700; color: #065f46; margin-bottom: 8px; text-transform: uppercase;">🔗 Affiliate Link for Your Bio</h3>
              <p style="font-size: 12px; color: #374151; margin-bottom: 8px;">Add this link to your bio before posting:</p>
              <a href="${affiliateLink}" style="font-size: 13px; color: #7c3aed; word-break: break-all;">${affiliateLink}</a>
              <p style="font-size: 11px; color: #6b7280; margin-top: 8px;">⚠️ Do not modify this link — it tracks purchases for your commission</p>
            </div>` : ''}

            <div style="background: #fef3c7; border: 1px solid #fcd34d; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
              <h3 style="font-size: 14px; font-weight: 700; color: #92400e; margin-bottom: 8px;">📋 Submission Checklist</h3>
              <ul style="font-size: 13px; color: #374151; padding-left: 20px; margin: 0; line-height: 2;">
                <li>Video is 30–60 seconds long</li>
                <li>Product is clearly visible on camera</li>
                <li>Call-to-action included at the end</li>
                <li>Affiliate link is in your bio before posting</li>
                <li>Submit your video URL in your dashboard</li>
              </ul>
            </div>

            <div style="text-align: center;">
              <a href="${process.env.FRONTEND_URL}/dashboard" style="display: inline-block; padding: 12px 28px; background: #7c3aed; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px;">
                Submit Your Video
              </a>
            </div>
          </div>
        </div>
      `
    });

    res.json({ message: 'Brief sent to your email!' });
  } catch (error) {
    console.error('Send brief error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
