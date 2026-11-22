import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { authMessage, confirmSignUp, resendCode, signIn, takeAutoSignIn } from '@/lib/cognito';
import { useAuth } from '@/lib/auth';
import { AuthScreen, Button, Input, LinkText, ui } from '@/components/ui';

// The 6-digit code Cognito emails after signup.
export default function Confirm() {
  const { email, resend } = useLocalSearchParams<{ email?: string; resend?: string }>();
  const { refresh } = useAuth();
  const [code, setCode] = useState('');
  const [note, setNote] = useState(resend ? '' : `We sent a 6-digit code to ${email}.`);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Came from login with an unconfirmed account: send a fresh code.
  useEffect(() => {
    if (resend && email)
      resendCode(email)
        .then(() => setNote(`Your email isn't confirmed yet. We sent a new code to ${email}.`))
        .catch((e) => setErr(authMessage(e)));
  }, [resend, email]);

  if (!email) return <Redirect href="/signup" />;

  async function submit() {
    setErr('');
    setBusy(true);
    try {
      await confirmSignUp(email!, code.trim());
      const saved = takeAutoSignIn(email!);
      if (saved) {
        await signIn(saved.email, saved.password);
        await refresh();
      } else router.replace('/login');
    } catch (e) {
      setErr(authMessage(e));
      setBusy(false);
    }
  }

  async function again() {
    setErr('');
    try {
      await resendCode(email!);
      setNote(`New code sent to ${email}.`);
    } catch (e) {
      setErr(authMessage(e));
    }
  }

  return (
    <AuthScreen title="Check your email." subtitle={note || undefined}>
      <Input
        placeholder="123456"
        value={code}
        onChangeText={(v) => setCode(v.replace(/\D/g, ''))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={6}
        style={{ fontSize: 24, letterSpacing: 8, textAlign: 'center' }}
      />
      {!!err && <Text style={ui.error}>{err}</Text>}
      <Button title="Confirm" onPress={submit} busy={busy} disabled={code.length < 6} />
      <LinkText onPress={again}>Send a new code</LinkText>
      <Text style={[ui.muted, { fontSize: 13, textAlign: 'center' }]}>Not there? Check spam for “Your Travel Buddy code”.</Text>
    </AuthScreen>
  );
}
