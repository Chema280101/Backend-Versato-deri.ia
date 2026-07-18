import request from 'supertest';
import app from '../app';
import { pool, getCatalogItems } from '../services/db.service';
import { runMigrations } from '../migrations';

describe('Catalog Import and Query Integration Tests', () => {
  const testSchema = 'test_catalog_import';

  beforeAll(async () => {
    // 1. Create a clean test schema
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.query(`CREATE SCHEMA ${testSchema};`);
    // Set search_path for the client session
    await pool.query(`SET search_path TO ${testSchema};`);

    // 2. Run migrations
    await runMigrations(pool);

    // 3. Create a second test business in addition to default business (id=1)
    await pool.query(`
      INSERT INTO businesses (id, name, phone_number_id)
      VALUES (2, 'Second Business', '222222222222222')
      ON CONFLICT (id) DO NOTHING;
    `);
    await pool.query(`
      SELECT setval(pg_get_serial_sequence('businesses', 'id'), COALESCE(MAX(id), 2)) FROM businesses;
    `);
  });

  afterAll(async () => {
    // Clean up schema and connection
    await pool.query('SET search_path TO public;');
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.end();
  });

  it('should successfully import catalog items via CSV parsing', async () => {
    const csvData = `nombre,descripción,precio,stock,categoría
Café Express,Café cargado estilo italiano,2.50,100,cafeteria
Muffin de Vainilla,Muffin dulce esponjoso,3.00,45,reposteria
Café Capuccino,Espresso con leche espumada,3.80,60,cafeteria`;

    // Import for Business ID = 1 (Default Business)
    const response1 = await request(app).post('/internal/catalog/import').send({
      business_id: 1,
      csv: csvData,
    });

    expect(response1.status).toBe(201);
    expect(response1.body).toHaveProperty('message', 'Catalog imported successfully');
    expect(response1.body).toHaveProperty('imported_count', 3);

    // Import a different catalog for Business ID = 2 (Second Business)
    const csvData2 = `nombre,descripción,precio,stock,categoría
Tarta de Manzana,Tarta clásica con manzanas,4.50,15,reposteria
Pan Integral,Pan de trigo integral,1.80,50,panaderia`;

    const response2 = await request(app).post('/internal/catalog/import').send({
      business_id: 2,
      csv: csvData2,
    });

    expect(response2.status).toBe(201);
    expect(response2.body).toHaveProperty('imported_count', 2);
  });

  it('should retrieve catalog items filtered by business_id and by category correctly', async () => {
    // 1. Check all items for Business ID = 1
    // The seed from migration 004 had:
    // - Café Latte (bebidas)
    // - Tarta de Manzana (postres)
    // - Croissant de Almendras (panaderia)
    // Plus we imported:
    // - Café Express (cafeteria)
    // - Muffin de Vainilla (reposteria)
    // - Café Capuccino (cafeteria)

    // Test filtering by business ID = 1 and category = 'cafeteria'
    const cafeteriaItems = await getCatalogItems(1, 'cafeteria');
    expect(cafeteriaItems.length).toBe(2);
    expect(cafeteriaItems.map((item) => item.nombre)).toContain('Café Express');
    expect(cafeteriaItems.map((item) => item.nombre)).toContain('Café Capuccino');

    // Test filtering by business ID = 1 and category = 'Computación' (seeded from the user's CSV)
    const computacionItems = await getCatalogItems(1, 'Computación');
    expect(computacionItems.length).toBe(3);
    expect(computacionItems.map((item) => item.nombre)).toContain('Monitor UltraWide 34"');
    expect(computacionItems.map((item) => item.nombre)).toContain('Teclado Mecánico Pro');
    expect(computacionItems.map((item) => item.nombre)).toContain('Ratón Ergonómico M1');

    // 2. Check items for Business ID = 2
    // Imported:
    // - Tarta de Manzana (reposteria)
    // - Pan Integral (panaderia)
    const business2Panaderia = await getCatalogItems(2, 'panaderia');
    expect(business2Panaderia.length).toBe(1);
    expect(business2Panaderia[0].nombre).toBe('Pan Integral');

    const business2Cafeteria = await getCatalogItems(2, 'cafeteria');
    expect(business2Cafeteria.length).toBe(0);
  });

  it('should return 400 Bad Request for invalid inputs', async () => {
    // Missing business_id
    const res1 = await request(app).post('/internal/catalog/import').send({
      csv: 'nombre,descripción,precio,stock,categoría\nItem 1,Desc,1.0,10,cat',
    });
    expect(res1.status).toBe(400);

    // Missing csv content
    const res2 = await request(app).post('/internal/catalog/import').send({
      business_id: 1,
    });
    expect(res2.status).toBe(400);

    // Missing required column in CSV headers
    const res3 = await request(app).post('/internal/catalog/import').send({
      business_id: 1,
      csv: 'nombre,descripción,stock,categoría\nItem,Desc,10,cat',
    });
    expect(res3.status).toBe(400);

    // Non-existent business_id
    const res4 = await request(app).post('/internal/catalog/import').send({
      business_id: 99999,
      csv: 'nombre,descripción,precio,stock,categoría\nItem,Desc,1.00,10,cat',
    });
    expect(res4.status).toBe(400);
    expect(res4.body.error).toContain('Foreign key constraint violation');
  });
});
