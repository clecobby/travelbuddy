// AWS Lambda entry point: the same Express app behind a Lambda Function URL.
import { configure } from '@codegenie/serverless-express';
import { app } from './server.ts';

export const handler = configure({ app });
