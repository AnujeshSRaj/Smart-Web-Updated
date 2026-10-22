import { answerPageQuestion } from '../services/chat.service.js';

/** HTTP adapter; business rules live in chat.service.js. */
export async function handleChat(req, res) {
  const data = await answerPageQuestion({
    userId: req.user.id,
    input: req.validated.body,
    apiKey: req.get('X-Groq-API-Key'),
  });
  res.json(data);
}
