import { useState } from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import { authMessage, rememberForAutoSignIn, signIn } from '@/lib/cognito';
import { useAuth } from '@/lib/auth';
import { AuthScreen, Button, Input, LinkText, ui } from '@/components/ui';

export default function Login() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const e = email.trim().toLowerCase();
    if (!e || !password) return setErr('Enter your email and password.');
    setErr('');
    setBusy(true);
    try {
      if ((await signIn(e, password)) === 'CONFIRM_SIGN_UP') {
        rememberForAutoSignIn(e, password);
        setBusy(false);
        return router.push({ pathname: '/confirm', params: { email: e, resend: '1' } });
      }
      await refresh();
    } catch (x) {
      setErr(authMessage(x));
      setBusy(false);
    }
  }

  return (
    <AuthScreen title="Welcome back." subtitle="Your trips, routes and conversations are saved to your account.">
      <Input placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoCorrect={false} autoComplete="email" textContentType="username" />
      <Input placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" onSubmitEditing={submit} returnKeyType="go" />
      {!!err && <Text style={ui.error}>{err}</Text>}
      <Button title="Log in" onPress={submit} busy={busy} />
      <LinkText onPress={() => router.push('/reset')}>Forgot password?</LinkText>
      <LinkText onPress={() => router.replace('/signup')}>New here? Create an account</LinkText>
    </AuthScreen>
  );
}
