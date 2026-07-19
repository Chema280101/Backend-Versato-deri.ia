import request from 'supertest';
import bcryptjs from 'bcryptjs';
import jwt from 'jsonwebtoken';
import app from '../app';
import { pool } from '../services/db.service';
import { runMigrations } from '../migrations';
import { config as appConfig } from '../config';

jest.mock('pdf-parse', () => {
  return {
    PDFParse: class {
      private data: Uint8Array;
      constructor(data: Uint8Array) {
        this.data = data;
      }
      async getText() {
        // 'invalid_base64_data' decodes to 13 bytes. We simulate parse failure for short invalid base64 string.
        if (this.data && this.data.length < 50) {
          throw new Error('Invalid PDF structure');
        }
        return { text: 'Hola Mundo extraído de PDF' };
      }
    }
  };
});

describe('Business Configuration & Catalog API', () => {
  const testSchema = 'test_business_config_api';
  let tokenA: string;
  let tokenB: string;

  // A tiny, valid 1-page PDF file in Base64 (contains the text "Hola Mundo")
  const tinyPdfBase64 = 
    'JVBERi0xLjQKMSAwIG9iagogIDw8IC9UeXBlIC9DYXRhbG9nCiAgICAgL1BhZ2VzIDIgMCBSCiAgPj4KZW5kb2JqCjIgMCBvYmoKICA8PCAvVHlwZSAvUGFnZXMKICAgICAvS2lkcyBbIDMgMCBSIF0KICAgICAvQ291bnQgMQogID4+CmVuZG9iagozIDAgb2JqCiAgPDwgL1R5cGUgL1BhZ2UKICAgICAvUGFyZW50IDIgMCBSCiAgICAgL01lZGlhQm94IFsgMCAwIDU5NSA4NDIgXQogICAgIC9SZXNvdXJjZXMgPDwKICAgICAgIC9Gb250IDw8CiAgICAgICAgIC9GMSA0IDAgUgogICAgICAgPj4KICAgICA+PgogICAgIC9Db250ZW50cyA1IDAgUgogID4+CmVuZG9iago0IDAgb2JqCiAgPDwgL1R5cGUgL0ZvbnQKICAgICAvU3VidHlwZSAvVHlwZTEKICAgICAvQmFzZUZvbnQgL0hlbHZldGljYQogID4+CmVuZG9iago1IDAgb2JqCiAgPDwgL0xlbmd0aCA0NCA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDcwIDcwMCBUZCAoSG9sYSBNdW5kbykgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA2OSAwMDAwMCBuIAowMDAwMDAwMTM1IDAwMDAwIGYgCjAwMDAwMDAyOTUgMDAwMDAgbiAKMDAwMDAwMDM4MiAwMDAwMCBuIAp0cmFpbGVyCiAgPDwgL1NpemUgNgogICAgIC9Sb290IDEgMCBSCiAgPj4Kc3RhcnR4cmVmCjQ3NwolJUVPRg==';

  beforeAll(async () => {
    // Setup clean schema
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.query(`CREATE SCHEMA ${testSchema};`);
    await pool.query(`SET search_path TO ${testSchema};`);

    // Run migrations
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await runMigrations(pool);

    // Create Business A and Business B
    await pool.query(`
      INSERT INTO businesses (id, name, phone_number_id, brand_prompt, escalation_threshold)
      VALUES 
        (100, 'Business A', 'phone_a', 'Prompt A', 150.00),
        (200, 'Business B', 'phone_b', 'Prompt B', null)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Create users
    const passwordHash = bcryptjs.hashSync('testpass', 10);
    await pool.query(`
      INSERT INTO users (business_id, email, password_hash, nombre, rol)
      VALUES 
        (100, 'opA@test.com', '${passwordHash}', 'Operator A', 'operator'),
        (200, 'opB@test.com', '${passwordHash}', 'Operator B', 'operator');
    `);

    // Generate JWT tokens
    tokenA = jwt.sign({ business_id: 100, user_id: 1 }, appConfig.jwtSecret);
    tokenB = jwt.sign({ business_id: 200, user_id: 2 }, appConfig.jwtSecret);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
  });

  describe('GET /business/config', () => {
    it('should return configuration for authenticated Business A', async () => {
      const response = await request(app)
        .get('/business/config')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Business A');
      expect(response.body.brandPrompt).toBe('Prompt A');
      expect(response.body.escalationThreshold).toBe(150);
      expect(response.body.trainingInfo).toBeNull();
    });

    it('should return configuration for authenticated Business B', async () => {
      const response = await request(app)
        .get('/business/config')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Business B');
      expect(response.body.brandPrompt).toBe('Prompt B');
      expect(response.body.escalationThreshold).toBeNull();
    });

    it('should fail with 401 if token is not provided', async () => {
      const response = await request(app).get('/business/config');
      expect(response.status).toBe(401);
    });
  });

  describe('PUT /business/config', () => {
    it('should update settings under tenant isolation (Business A)', async () => {
      const updateResponse = await request(app)
        .put('/business/config')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Business A Updated',
          brandPrompt: 'New Prompt for A',
          escalationThreshold: 200,
          trainingInfo: 'Some basic policies text'
        });

      expect(updateResponse.status).toBe(200);
      expect(updateResponse.body.message).toContain('éxito');

      // Verify DB update
      const checkResponse = await request(app)
        .get('/business/config')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(checkResponse.body.name).toBe('Business A Updated');
      expect(checkResponse.body.brandPrompt).toBe('New Prompt for A');
      expect(checkResponse.body.escalationThreshold).toBe(200);
      expect(checkResponse.body.trainingInfo).toBe('Some basic policies text');

      // Verify Business B remains untouched (Multi-tenant isolation check)
      const bResponse = await request(app)
        .get('/business/config')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(bResponse.body.name).toBe('Business B');
      expect(bResponse.body.brandPrompt).toBe('Prompt B');
    });
  });

  describe('POST /business/upload-pdf', () => {
    it('should parse PDF and append text to trainingInfo', async () => {
      const response = await request(app)
        .post('/business/upload-pdf')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ pdfBase64: tinyPdfBase64 });

      expect(response.status).toBe(200);
      expect(response.body.message).toContain('éxito');
      expect(response.body.extractedLength).toBeGreaterThan(0);
      expect(response.body.fullTrainingInfo).toContain('Hola Mundo extraído de PDF');
    });

    it('should fail if PDF base64 is invalid', async () => {
      const response = await request(app)
        .post('/business/upload-pdf')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ pdfBase64: 'invalid_base64_data' });

      expect(response.status).toBe(500); // Decodes to invalid pdf buffer causing pdf-parse to fail
    });
  });
});
