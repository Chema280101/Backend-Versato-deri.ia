import { Router, Request, Response } from 'express';
import { createCatalogItem } from '../services/db.service';
import { sanitizeInput } from '../utils/sanitization';

const router = Router();

// Helper to normalize strings (remove accents and lowercase)
function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Custom parser to split CSV lines, supporting quotes
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

router.post('/internal/catalog/import', async (req: Request, res: Response): Promise<void> => {
  try {
    const { business_id, csv } = req.body;

    if (business_id === undefined || typeof business_id !== 'number') {
      res.status(400).json({ error: 'business_id is required and must be a number' });
      return;
    }

    if (!csv || typeof csv !== 'string') {
      res.status(400).json({ error: 'csv string is required in the body' });
      return;
    }

    const lines = csv.split(/\r?\n/);
    if (lines.length < 2) {
      res.status(400).json({ error: 'CSV must contain at least headers and one data row' });
      return;
    }

    const headers = parseCSVLine(lines[0]).map(normalizeHeader);

    // Find column positions
    const nameIndex = headers.indexOf('nombre');
    const descIndex = headers.indexOf('descripcion');
    const priceIndex = headers.indexOf('precio');
    const stockIndex = headers.indexOf('stock');
    const catIndex = headers.indexOf('categoria');

    if (nameIndex === -1 || priceIndex === -1 || stockIndex === -1 || catIndex === -1) {
      res.status(400).json({
        error: `CSV is missing required headers. Required: nombre, precio, stock, categoria. Found: ${headers.join(', ')}`,
      });
      return;
    }

    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = parseCSVLine(line);
      const nombre = values[nameIndex] ? sanitizeInput(values[nameIndex]) : '';
      const descripcion = descIndex !== -1 && values[descIndex] ? sanitizeInput(values[descIndex]) : '';
      const precio = parseFloat(values[priceIndex]);
      const stock = parseInt(values[stockIndex], 10);
      const categoria = values[catIndex] ? sanitizeInput(values[catIndex]) : '';

      if (!nombre || isNaN(precio) || isNaN(stock) || !categoria) {
        console.warn(`[WARNING]: Skipping invalid CSV line: "${line}"`);
        continue;
      }

      await createCatalogItem({
        businessId: business_id,
        nombre,
        descripcion: descripcion || null,
        precio,
        stock,
        categoria,
        activo: true,
      });
      count++;
    }

    res.status(201).json({
      message: 'Catalog imported successfully',
      imported_count: count,
    });
  } catch (error: any) {
    console.error('[ERROR]: Failed to import catalog from CSV:', error);
    if (error.code === '23503') {
      res
        .status(400)
        .json({ error: 'Foreign key constraint violation. business_id might not exist.' });
      return;
    }
    res.status(500).json({ error: 'Internal server error while importing catalog' });
  }
});

export default router;
