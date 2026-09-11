const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

jest.mock('axios');
const axios = require('axios');

// Mock Review model
jest.mock('../models/Review', () => {
  const mongoose = require('mongoose');
  return function Review(data) {
    this._id = data._id || new mongoose.Types.ObjectId();
    this.orgId = data.orgId || new mongoose.Types.ObjectId();
    this.googleResourceName = data.googleResourceName || 'testResource';
    this.save = jest.fn().mockResolvedValue(this);
    this.status = data.status || 'pending';
  };
});

// Mock Reply model
jest.mock('../models/Reply', () => {
  const mongoose = require('mongoose');
  return function Reply(data) {
    this._id = data._id || new mongoose.Types.ObjectId();
    this.orgId = data.orgId || new mongoose.Types.ObjectId();
    this.draftReply = data.draftReply || 'Draft reply';
    this.save = jest.fn().mockResolvedValue(this);
  };
});

const Review = require('../models/Review');
const Reply = require('../models/Reply');

const app = require('../index');

function generateToken(orgId) {
  const payload = { organizationId: orgId };
  const secret = process.env.JWT_SECRET || 'testsecret';
  return jwt.sign(payload, secret, { expiresIn: '1h' });
}

describe('POST /api/reply/approve webhook integration', () => {
  const orgId = new mongoose.Types.ObjectId();
  const reviewId = new mongoose.Types.ObjectId();
  const token = generateToken(orgId);

  beforeEach(() => {
    jest.clearAllMocks();
    Review.findById = jest.fn().mockResolvedValue({
      _id: reviewId,
      orgId,
      googleResourceName: 'accounts/123/locations/loc_123/reviews/rev_123',
      save: jest.fn().mockResolvedValue(null),
      status: 'pending',
    });
    Reply.findOne = jest.fn().mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      orgId,
      draftReply: 'Generated draft',
      save: jest.fn().mockResolvedValue(null),
    });
  });

  test('returns 500 when webhook URL is not configured', async () => {
    delete process.env.MAKE_APPROVED_REPLY_WEBHOOK_URL;
    const response = await request(app)
      .post('/api/reply/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({ reviewId: reviewId.toString() });
    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Make.com webhook URL not configured');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('calls webhook and returns success on webhook success', async () => {
    process.env.MAKE_APPROVED_REPLY_WEBHOOK_URL = 'https://example.com/webhook';
    axios.post.mockResolvedValue({ status: 200, data: {} });
    const response = await request(app)
      .post('/api/reply/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({ reviewId: reviewId.toString(), finalReply: 'Final reply text' });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Reply approved and webhook notified');
    expect(axios.post).toHaveBeenCalledWith('https://example.com/webhook', {
      reviewId: expect.anything(),
      orgId: expect.anything(),
      finalReply: 'Final reply text',
      googleResourceName: expect.any(String),
    });
  });

  test('returns 502 when webhook call fails', async () => {
    process.env.MAKE_APPROVED_REPLY_WEBHOOK_URL = 'https://example.com/webhook';
    axios.post.mockRejectedValue(new Error('Network error'));
    const response = await request(app)
      .post('/api/reply/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({ reviewId: reviewId.toString() });
    expect(response.status).toBe(502);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Approved but failed to notify Make.com webhook');
    expect(axios.post).toHaveBeenCalled();
  });
});
