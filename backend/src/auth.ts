import type { NextFunction, Request, Response } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

// Accounts (signup, email confirmation, login, password reset) live in Amazon Cognito.
// The app sends the Cognito ID token on every request; we check it against the user pool's keys.
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
if (!USER_POOL_ID || !CLIENT_ID) throw new Error('COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set');

const verifier = CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, tokenUse: 'id' });
const cognito = new CognitoIdentityProviderClient({});

export type User = { id: string; email: string; username: string };
export type Authed = Request & { user: User };

export async function auth(req: Request, res: Response, next: NextFunction) {
  const token = (req.get('authorization') || '').replace(/^Bearer /i, '');
  try {
    const claims = await verifier.verify(token);
    if (!claims.email_verified) return res.status(401).json({ error: 'Confirm your email first.' });
    (req as Authed).user = { id: claims.sub, email: String(claims.email), username: String(claims['cognito:username']) };
    next();
  } catch {
    res.status(401).json({ error: 'Please sign in again.' });
  }
}

export const deleteCognitoUser = (username: string) =>
  cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));

// Auth proxy for the app: the phone posts its Cognito calls here and we forward them to Cognito.
// Some mobile networks can't reach cognito-idp.amazonaws.com directly but can reach our API.
// Only the unauthenticated app-client actions are allowed, and only for our own app client.
const ACTIONS = new Set([
  'SignUp', 'ConfirmSignUp', 'ResendConfirmationCode', 'InitiateAuth',
  'GetTokensFromRefreshToken', 'RevokeToken', 'ForgotPassword', 'ConfirmForgotPassword',
]);

export async function cognitoProxy(req: Request, res: Response) {
  const { action, body } = req.body ?? {};
  if (!ACTIONS.has(action) || body?.ClientId !== CLIENT_ID) return res.status(400).json({ __type: 'InvalidParameterException', message: 'Unsupported request' });
  const region = process.env.AWS_REGION || 'us-east-1';
  let r: globalThis.Response;
  try {
    r = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error('cognito proxy failed', action, (e as Error).message);
    return res.status(502).json({ __type: 'NetworkError', message: "Couldn't reach the login service." });
  }
  // Pass Cognito's answer straight back: its JSON and __type error names are what the app expects.
  res.status(r.status).type('application/json').send(await r.text());
}
