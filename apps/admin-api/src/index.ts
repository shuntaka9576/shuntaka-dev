import { handle } from 'hono/aws-lambda';
import { app } from './app.js';
import { runTodoBatch } from './todo/batch.js';

const httpHandler = handle(app);

export const handler = async (...args: Parameters<typeof httpHandler>) => {
  const [event] = args;
  if ((event as unknown as { task?: string }).task === 'generate-daily-todos') {
    return runTodoBatch();
  }
  return httpHandler(...args);
};
