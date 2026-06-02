require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Environment variables
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appR4epAyspylO9Hr';
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
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

// ===== PRODUCTS ENDPOINTS =====

// Get all products
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

// Get single product
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

// Register new influencer
app.post('/api/influencers/register', async (req, res) => {
  const { email, username, displayName, niche, followerCount, socialLinks } = req.body;
  
  try {
    const record = await airtableCall('POST', 'Influencers', {
      fields: {
        'Email': email,
        'Username': username,
        'Display Name': displayName,
        'Niche': niche,
        'Follower Count': followerCount,
        'Social Links': socialLinks,
        'Verification Status': 'Pending'
      }
    });
    
    res.json({
      id: record.id,
      message: 'Influencer registered successfully'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to register influencer' });
  }
});

// Get influencer by email
app.get('/api/influencers/:email', async (req, res) => {
  try {
    const data = await airtableCall('GET', 'Influencers', {
      params: {
        filterByFormula: `{Email} = '${req.params.email}'`
      }
    });
    
    if (data.records.length === 0) {
      return res.status(404).json({ error: 'Influencer not found' });
    }
    
    const record = data.records[0];
    res.json({
      id: record.id,
      ...record.fields
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch influencer' });
  }
});

// ===== SUBMISSION ENDPOINTS =====

// Create submission
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

// Get submissions for influencer
app.get('/api/submissions/influencer/:influencerId', async (req, res) => {
  try {
    const data = await airtableCall('GET', 'Submissions', {
      params: {
        filterByFormula: `FIND('${req.params.influencerId}', ARRAYUNIQUE({Influencer})) > 0`
      }
    });
    
    const submissions = data.records.map(record => ({
      id: record.id,
      ...record.fields
    }));
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// ===== STRIPE PAYMENT ENDPOINTS =====

// Create payment intent
app.post('/api/payments/create-intent', async (req, res) => {
  const { amount, influencerId, submissionId } = req.body;
  
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: 'usd',
      metadata: {
        influencerId,
        submissionId
      }
    });
    
    res.json({
      clientSecret: paymentIntent.client_secret
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

// Stripe webhook (for payment confirmation)
app.post('/api/payments/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    
    if (event.type === 'payment_intent.succeeded') {
      const { id, metadata } = event.data.object;
      
      // Update submission as paid
      await airtableCall('PATCH', `Submissions/${metadata.submissionId}`, {
        fields: {
          'Status': 'Approved',
          'Paid': true
        }
      });
      
      // Create payout record
      await airtableCall('POST', 'Payouts', {
        fields: {
          'Payout ID': `PAY-${id}`,
          'Total Amount': event.data.object.amount / 100,
          'Status': 'Pending',
          'Stripe Transaction ID': id,
          'Influencer': [metadata.influencerId]
        }
      });
    }
    
    res.json({ received: true });
  } catch (error) {
    res.status(400).send(`Webhook error: ${error.message}`);
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
});
