import { useState } from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import { authMessage, confirmForgotPassword, forgotPassword } from '@/lib/cognito';
import { AuthScreen, Button, Input, LinkText, ui } from '@/components/ui';

// Forgot password: email → code + new password → log in.
export default function Reset() {
  const [step, setStep] = useState<'email' | 'code' | 'done'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const e = email.trim().toLowerCase();
    setErr('');
    setBusy(true);
    try {
      if (step === 'email') {
        await forgotPassword(e);
        setStep('code');
      } else {
        await confirmForgotPassword(e, code.trim(), password);
        setStep('done');
      }
    } catch (x) {
      setErr(authMessage(x));
    } finally {
      setBusy(false);
    }
  }

  if (step === 'done')
    return (
      <AuthScreen title="All set." subtitle="Your password has been changed.">
        <Button title="Log in" onPress={() => router.replace('/login')} />
      </AuthScreen>
    );

  return (
    <AuthScreen title="New password." subtitle={step === 'email' ? "We'll email you a code." : 'If that email has an account, we sent it a code.'}>
      <Input placeholder="Email" value={email} onChangeText={setEmail} editable={step === 'email'} autoCapitalize="none" keyboardType="email-address" autoCorrect={false} autoComplete="email" />
      {step === 'code' && (
        <>
          <Input placeholder="123456" value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} />
          <Input placeholder="New password (10+ characters, Aa, 1)" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
        </>
      )}
      {!!err && <Text style={ui.error}>{err}</Text>}
      <Button title={step === 'email' ? 'Send code' : 'Set password'} onPress={submit} busy={busy} />
      <LinkText onPress={() => router.back()}>Back to log in</LinkText>
    </AuthScreen>
  );
}
