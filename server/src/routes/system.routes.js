import { Router } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { handleAuthConfig, handleHealth, handleReadiness } from '../controllers/system.controller.js';

const router = Router();
router.get('/health', handleHealth);
router.get('/ready', asyncHandler(handleReadiness));
router.get('/auth-config', handleAuthConfig);

export default router;
