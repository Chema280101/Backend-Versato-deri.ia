import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import {
  getBusinessConfig,
  updateBusinessConfig,
  getCatalogItems,
  createCatalogItem,
  updateCatalogItem,
  deleteCatalogItem,
} from '../services/db.service';
import { sanitizeInput } from '../utils/sanitization';
const { PDFParse } = require('pdf-parse');

const router = Router();

// Apply authentication middleware to protect all routes
router.use(authMiddleware);

/**
 * GET /business/config
 * Retrieves the configuration of the current authenticated business/tenant.
 */
router.get('/business/config', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const config = await getBusinessConfig(businessId);
    if (!config) {
      res.status(404).json({ error: 'Business configuration not found' });
      return;
    }
    res.json(config);
  } catch (error) {
    console.error('[ERROR]: Failed to fetch business config:', error);
    res.status(500).json({ error: 'Internal server error while fetching business configuration' });
  }
});

/**
 * PUT /business/config
 * Updates the configuration parameters of the business/tenant.
 */
router.put('/business/config', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const { name, brandPrompt, escalationThreshold, trainingInfo } = req.body;

    const updates: {
      name?: string;
      brandPrompt?: string | null;
      escalationThreshold?: number | null;
      trainingInfo?: string | null;
    } = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim() === '') {
        res.status(400).json({ error: 'El nombre del negocio no puede estar vacío' });
        return;
      }
      updates.name = sanitizeInput(name);
    }

    if (brandPrompt !== undefined) {
      updates.brandPrompt = brandPrompt ? sanitizeInput(brandPrompt) : null;
    }

    if (escalationThreshold !== undefined) {
      if (escalationThreshold === null) {
        updates.escalationThreshold = null;
      } else {
        const parsedVal = parseFloat(escalationThreshold);
        if (isNaN(parsedVal) || parsedVal < 0) {
          res.status(400).json({ error: 'El umbral de escalamiento debe ser un número positivo o nulo' });
          return;
        }
        updates.escalationThreshold = parsedVal;
      }
    }

    if (trainingInfo !== undefined) {
      updates.trainingInfo = trainingInfo ? sanitizeInput(trainingInfo) : null;
    }

    await updateBusinessConfig(businessId, updates);
    res.json({ message: 'Configuración actualizada con éxito' });
  } catch (error) {
    console.error('[ERROR]: Failed to update business config:', error);
    res.status(500).json({ error: 'Internal server error while updating business configuration' });
  }
});

/**
 * POST /business/upload-pdf
 * Extracts text content from a base64 encoded PDF file and updates business training information.
 */
router.post('/business/upload-pdf', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const { pdfBase64 } = req.body;

    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      res.status(400).json({ error: 'Fichero PDF en formato Base64 es requerido.' });
      return;
    }

    // Convert base64 to binary buffer and wrap in Uint8Array
    const pdfData = Buffer.from(pdfBase64, 'base64');
    const arrayBuffer = new Uint8Array(pdfData.buffer, pdfData.byteOffset, pdfData.byteLength);
    
    // Parse PDF using the PDFParse class
    const parser = new PDFParse(arrayBuffer);
    const parsedData = await parser.getText();
    const extractedText = parsedData.text || '';
    
    if (!extractedText.trim()) {
      res.status(400).json({ error: 'El PDF cargado no contiene texto legible.' });
      return;
    }

    // Sanitize and append or overwrite business training info
    const sanitizedText = sanitizeInput(extractedText);
    
    // Retrieve current configuration
    const currentConfig = await getBusinessConfig(businessId);
    const newTrainingInfo = currentConfig?.trainingInfo 
      ? `${currentConfig.trainingInfo}\n\n[POLÍTICAS IMPORTADAS DESDE PDF]:\n${sanitizedText}`
      : `[POLÍTICAS IMPORTADAS DESDE PDF]:\n${sanitizedText}`;

    await updateBusinessConfig(businessId, { trainingInfo: newTrainingInfo });

    res.json({
      message: 'PDF procesado y entrenado con éxito',
      extractedLength: sanitizedText.length,
      fullTrainingInfo: newTrainingInfo
    });
  } catch (error: any) {
    console.error('[ERROR]: Failed to process and extract text from PDF:', error);
    res.status(500).json({ error: `Error al procesar el PDF: ${error.message || error}` });
  }
});

/**
 * GET /business/catalog
 * Lists all catalog items for the authenticated business.
 */
router.get('/business/catalog', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const items = await getCatalogItems(businessId);
    res.json(items);
  } catch (error) {
    console.error('[ERROR]: Failed to list catalog items:', error);
    res.status(500).json({ error: 'Error al obtener los artículos del catálogo' });
  }
});

/**
 * POST /business/catalog
 * Creates a catalog item for the authenticated business.
 */
router.post('/business/catalog', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const { nombre, descripcion, precio, stock, categoria, activo } = req.body;

    if (!nombre || typeof nombre !== 'string' || nombre.trim() === '') {
      res.status(400).json({ error: 'El nombre es obligatorio' });
      return;
    }

    const parsedPrice = parseFloat(precio);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      res.status(400).json({ error: 'El precio debe ser un número válido positivo' });
      return;
    }

    const parsedStock = parseInt(stock, 10);
    if (isNaN(parsedStock) || parsedStock < 0) {
      res.status(400).json({ error: 'El stock debe ser un número entero válido positivo' });
      return;
    }

    if (!categoria || typeof categoria !== 'string' || categoria.trim() === '') {
      res.status(400).json({ error: 'La categoría es obligatoria' });
      return;
    }

    const itemId = await createCatalogItem({
      businessId,
      nombre: sanitizeInput(nombre),
      descripcion: descripcion ? sanitizeInput(descripcion) : null,
      precio: parsedPrice,
      stock: parsedStock,
      categoria: sanitizeInput(categoria),
      activo: activo === undefined ? true : !!activo,
    });

    res.status(201).json({ message: 'Producto agregado con éxito', id: itemId });
  } catch (error) {
    console.error('[ERROR]: Failed to create catalog item:', error);
    res.status(500).json({ error: 'Error interno al agregar producto al catálogo' });
  }
});

/**
 * PUT /business/catalog/:id
 * Updates a catalog item. Validates tenant ownership.
 */
router.put('/business/catalog/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'ID de producto inválido' });
      return;
    }

    const { nombre, descripcion, precio, stock, categoria, activo } = req.body;
    const updates: any = {};

    if (nombre !== undefined) {
      if (typeof nombre !== 'string' || nombre.trim() === '') {
        res.status(400).json({ error: 'El nombre no puede estar vacío' });
        return;
      }
      updates.nombre = sanitizeInput(nombre);
    }

    if (descripcion !== undefined) {
      updates.descripcion = descripcion ? sanitizeInput(descripcion) : null;
    }

    if (precio !== undefined) {
      const parsedPrice = parseFloat(precio);
      if (isNaN(parsedPrice) || parsedPrice < 0) {
        res.status(400).json({ error: 'El precio debe ser un número válido positivo' });
        return;
      }
      updates.precio = parsedPrice;
    }

    if (stock !== undefined) {
      const parsedStock = parseInt(stock, 10);
      if (isNaN(parsedStock) || parsedStock < 0) {
        res.status(400).json({ error: 'El stock debe ser un entero positivo' });
        return;
      }
      updates.stock = parsedStock;
    }

    if (categoria !== undefined) {
      if (typeof categoria !== 'string' || categoria.trim() === '') {
        res.status(400).json({ error: 'La categoría no puede estar vacía' });
        return;
      }
      updates.categoria = sanitizeInput(categoria);
    }

    if (activo !== undefined) {
      updates.activo = !!activo;
    }

    await updateCatalogItem(id, businessId, updates);
    res.json({ message: 'Producto actualizado con éxito' });
  } catch (error) {
    console.error('[ERROR]: Failed to update catalog item:', error);
    res.status(500).json({ error: 'Error interno al editar producto del catálogo' });
  }
});

/**
 * DELETE /business/catalog/:id
 * Deletes a catalog item. Validates tenant ownership.
 */
router.delete('/business/catalog/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'ID de producto inválido' });
      return;
    }

    await deleteCatalogItem(id, businessId);
    res.json({ message: 'Producto eliminado del catálogo con éxito' });
  } catch (error) {
    console.error('[ERROR]: Failed to delete catalog item:', error);
    res.status(500).json({ error: 'Error interno al eliminar producto del catálogo' });
  }
});

export default router;
