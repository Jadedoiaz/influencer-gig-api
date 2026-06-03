require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const sgMail = require('@sendgrid/mail');

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const app = express();

// Middleware
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://www.influencergigs.xyz',
    'https://influencer-gig-web.vercel.app'
  ]
}));
app.use(express.json());

// Environment variables
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appR4epAyspylO9Hr';
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const STRIPE_CLIENT_ID = process.env.STRIPE_CLIENT_ID;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'hello@influencergigs.xyz';
const AIRTABLE_API_URL = 'https://api.airtable.com/v0';

// Airtable helper function
const airtableCall = async (method, endpoint, data = null) => {
  try {
    const config = {
      method,
      url: `${AIRTABLE_API_URL}/${AIRTABLE_BASE_ID}/${endpoint}`,
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    };
    if (data) config.data = data;
    
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error('Airtable error:', error.response?.data || error.message);
    throw error;
  }
};

// Email verification template
const getVerificationEmailTemplate = (name, influencerId, verificationLink) => {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 8px 8px; }
        .cta-button { 
          display: inline-block; 
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white; 
          padding: 12px 30px; 
          text-decoration: none; 
          border-radius: 6px; 
          margin: 20px 0;
        }
        .footer { text-align: center; padding: 20px; color: #999; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Welcome to InfluencerGig! 🎬</h1>
        </div>
        <div class="content">
          <p>Hi ${name},</p>
          <p>Thank you for signing up! We're excited to have you on board.</p>
          <p>Please verify your email address to complete your registration and start earning money by creating UGC videos.</p>
          <center>
            <a href="${verificationLink}" class="cta-button">Verify Email Address</a>
          </center>
          <p style="color: #999; font-size: 12px;">Or copy and paste this link in your browser:<br>${verificationLink}</p>
          <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
          <p><strong>What's Next?</strong></p>
          <ul>
            <li>Browse 51+ products available</li>
            <li>Create authentic UGC videos</li>
            <li>Earn $10-50 per approved video</li>
            <li>Get paid within 24 hours!</li>
          </ul>
          <p>If you have any questions, contact us at <a href="mailto:hello@influencergigs.xyz">hello@influencergigs.xyz</a></p>
        </div>
        <div class="footer">
          <p>&copy; 2026 InfluencerGig. All rights reserved.</p>
          <p><a href="https://www.influencergig.online/privacy-policy.html">Privacy Policy</a> | <a href="https://www.influencergig.online/terms-of-service.html">Terms of Service</a></p>
        </div>
      </div>
    </body>
    </html>
  `;
};

// ===== STRIPE CONNECT ENDPOINTS =====

app.post('/api/creators/stripe-connect', async (req, res) => {
  const { email, displayName, influencerId } = req.body;
  
  try {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: email,
      business_type: 'individual',
      individual: {
        first_name: displayName.split(' ')[0],
        last_name: displayName.split(' ')[1] || '',
        email: email
      },
      business_profile: {
        mcc: '7399',
        url: 'https://www.influencergigs.xyz'
      }
    });

    await airtableCall('PATCH', `Influencers/${influencerId}`, {
      fields: {
        'Stripe Account ID': account.id
      }
    });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      type: 'account_onboarding',
      refresh_url: 'https://www.influencergigs.xyz/dashboard',
      return_url: 'https://www.influencergigs.xyz/dashboard'
    });

    res.json({
      success: true,
      onboarding_url: accountLink.url,
      message: 'Complete Stripe account setup to start earning'
    });
  } catch (error) {
    console.error('Stripe Connect error:', error);
    res.status(500).json({ error: 'Failed to create Stripe account' });
  }
});

app.get('/api/creators/:influencerId/stripe-status', async (req, res) => {
  try {
    const influencerData = await airtableCall('GET', `Influencers/${req.params.influencerId}`);
    const stripeAccountId = influencerData.fields['Stripe Account ID'];

    if (!stripeAccountId) {
      return res.json({ ready: false, message: 'Not connected' });
    }

    const account = await stripe.accounts.retrieve(stripeAccountId);
    const ready = account.charges_enabled && account.payouts_enabled;

    res.json({
      ready: ready,
      account_id: stripeAccountId,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled
    });
  } catch (error) {
    console.error('Stripe status error:', error);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// ===== PRODUCTS ENDPOINTS =====

app.get('/api/products', async (req, res) => {
  try {
    const data = await airtableCall('GET', 'Products');
    const products = data.records.map(record => ({
      id: record.id,
      ...record.fields
    }));
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const data = await airtableCall('GET', `Products/${req.params.id}`);
    res.json({
      id: data.id,
      ...data.fields
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// ===== INFLUENCER ENDPOINTS =====

// Register new influencer with email verification
app.post('/api/influencers/register', async (req, res) => {
  const { email, username, displayName, niche, followerCount, socialLinks } = req.body;
  
  try {
    // Create verification token (simple approach - in production use JWT)
    const verificationToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    
    // Create influencer record
    const record = await airtableCall('POST', 'Influencers', {
      fields: {
        'Email': email,
        'Username': username,
        'Display Name': displayName,
        'Niche': niche || '',
        'Follower Count': followerCount || 0,
        'Social Links': socialLinks || '',
        'Verification Status': 'Pending',
        'Verification Token': verificationToken
      }
    });

    // Build verification link
    const verificationLink = `https://www.influencergigs.xyz/verify?token=${verificationToken}&email=${encodeURIComponent(email)}`;

    // Send verification email
    const emailTemplate = getVerificationEmailTemplate(displayName, record.id, verificationLink);
    
    await sgMail.send({
      to: email,
      from: SENDGRID_FROM_EMAIL,
      subject: 'Welcome to InfluencerGig - Verify Your Email',
      html: emailTemplate,
      replyTo: 'hello@influencergigs.xyz'
    });

    res.json({
      id: record.id,
      message: 'Influencer registered successfully! Check your email to verify your account.',
      verificationSent: true
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register influencer' });
  }
});

// Verify email
app.post('/api/influencers/verify-email', async (req, res) => {
  const { token, email } = req.body;
  
  try {
    // Find influencer by email and token
    const data = await airtableCall('GET', 'Influencers');
    const influencer = data.records.find(r => 
      r.fields['Email'] === email && r.fields['Verification Token'] === token
    );

    if (!influencer) {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    // Update verification status
    await airtableCall('PATCH', `Influencers/${influencer.id}`, {
      fields: {
        'Verification Status': 'Verified',
        'Verification Token': '' // Clear token after use
      }
    });

    // Send welcome email
    const welcomeEmail = `
      <html>
      <body style="font-family: Arial, sans-serif;">
        <p>Welcome aboard, ${influencer.fields['Display Name']}!</p>
        <p>Your email has been verified. You can now:</p>
        <ul>
          <li>Browse available products</li>
          <li>Create UGC videos</li>
          <li>Submit videos for review</li>
          <li>Earn $10-50 per approved video</li>
        </ul>
        <p><a href="https://www.influencergigs.xyz/dashboard" style="background: #667eea; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px;">Go to Dashboard</a></p>
      </body>
      </html>
    `;

    await sgMail.send({
      to: email,
      from: SENDGRID_FROM_EMAIL,
      subject: 'Email Verified - Welcome to InfluencerGig!',
      html: welcomeEmail
    });

    res.json({
      success: true,
      message: 'Email verified! You can now start creating videos.'
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

// Get influencer by email
app.get('/api/influencers/:email', async (req, res) => {
  try {
    const data = await airtableCall('GET', 'Influencers');
    const records = data.records.filter(r => r.fields['Email'] === req.params.email);
    
    if (records.length === 0) {
      return res.status(404).json({ error: 'Influencer not found' });
    }
    
    const record = records[0];
    res.json({
      id: record.id,
      ...record.fields
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch influencer' });
  }
});

// ===== SUBMISSION ENDPOINTS =====

app.post('/api/submissions', async (req, res) => {
  const { influencerId, productId, videoUrl, caption } = req.body;
  
  try {
    const record = await airtableCall('POST', 'Submissions', {
      fields: {
        'Submission ID': `SUB-${Date.now()}`,
        'Video URL': videoUrl,
        'Caption': caption,
        'Influencer': [influencerId],
        'Product': [productId],
        'Status': 'Pending Review',
        'Submission Date': new Date().toISOString().split('T')[0]
      }
    });
    
    res.json({
      id: record.id,
      message: 'Submission created successfully'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create submission' });
  }
});

app.get('/api/submissions/influencer/:influencerId', async (req, res) => {
  try {
    const data = await airtableCall('GET', 'Submissions');
    
    const submissions = data.records
      .filter(record => record.fields['Influencer']?.includes(req.params.influencerId))
      .map(record => ({
        id: record.id,
        ...record.fields
      }));
    
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// ===== PAYMENT ENDPOINTS =====

app.post('/api/payments/create', async (req, res) => {
  const { submissionId, influencerId, amount } = req.body;
  
  try {
    const influencerData = await airtableCall('GET', `Influencers/${influencerId}`);
    const stripeAccountId = influencerData.fields['Stripe Account ID'];

    if (!stripeAccountId) {
      return res.status(400).json({ error: 'Creator has not connected Stripe account' });
    }

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: Math.round(amount * 100),
        currency: 'usd',
        metadata: {
          influencerId,
          submissionId
        },
        statement_descriptor: 'InfluencerGig Video'
      },
      { stripeAccount: stripeAccountId }
    );

    res.json({
      clientSecret: paymentIntent.client_secret,
      stripeAccountId: stripeAccountId
    });
  } catch (error) {
    console.error('Payment creation error:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// Webhook: Payment succeeded
app.post('/api/payments/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    
    if (event.type === 'payment_intent.succeeded') {
      const { metadata, amount } = event.data.object;
      
      const submissionsData = await airtableCall('GET', 'Submissions');
      const submission = submissionsData.records.find(
        record => record.fields['Submission ID'] === metadata.submissionId
      );

      if (submission) {
        await airtableCall('PATCH', `Submissions/${submission.id}`, {
          fields: {
            'Status': 'Approved',
            'Paid': true,
            'Reward Amount': amount / 100
          }
        });

        await airtableCall('POST', 'Payouts', {
          fields: {
            'Payout ID': `PAY-${event.data.object.id}`,
            'Total Amount': amount / 100,
            'Status': 'Completed',
            'Stripe Transaction ID': event.data.object.id,
            'Influencer': [metadata.influencerId]
          }
        });
      }
    }
    
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).send(`Webhook error: ${error.message}`);
  }
});

// ===== ADMIN ENDPOINTS =====

app.post('/api/admin/approve-submission', async (req, res) => {
  const { submissionId, influencerId, rewardAmount } = req.body;
  
  try {
    await airtableCall('PATCH', `Submissions/${submissionId}`, {
      fields: {
        'Status': 'Approved',
        'Reward Amount': rewardAmount
      }
    });

    const influencerData = await airtableCall('GET', `Influencers/${influencerId}`);
    const stripeAccountId = influencerData.fields['Stripe Account ID'];

    if (!stripeAccountId) {
      return res.status(400).json({ error: 'Creator has not connected Stripe account' });
    }

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: Math.round(rewardAmount * 100),
        currency: 'usd',
        metadata: { influencerId, submissionId },
        statement_descriptor: 'InfluencerGig Reward',
        confirm: true,
        payment_method: 'pm_card_visa'
      },
      { stripeAccount: stripeAccountId }
    );

    res.json({
      success: true,
      paymentId: paymentIntent.id,
      amount: rewardAmount,
      message: `Payment of $${rewardAmount} sent to creator`
    });
  } catch (error) {
    console.error('Approval error:', error);
    res.status(500).json({ error: 'Failed to approve submission' });
  }
});

// ===== HEALTH CHECK =====

app.get('/health', (req, res) => {
  res.json({ status: 'API is running' });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`💳 Stripe Connect enabled for direct creator payouts`);
  console.log(`📧 SendGrid email verification enabled`);
});
