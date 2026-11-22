import { useState } from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import { authMessage, rememberForAutoSignIn, signUp } from '@/lib/cognito';
import { AuthScreen, Button, Input, LinkText, ui } from '@/components/ui';

const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/;

export default function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const e = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(e)) return setErr('Enter a valid email address.');
    if (!PASSWORD_RULE.test(password)) return setErr('Password needs 10+ characters with upper and lower case letters and a number.');
    setErr('');
    setBusy(true);
    try {
      await signUp(e, password);
      rememberForAutoSignIn(e, password);
      router.push({ pathname: '/confirm', params: { email: e } });
    } catch (x) {
      setErr(authMessage(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen title="Your travel buddy." subtitle="Create an account to record trips and keep them wherever you go.">
      <Input placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoCorrect={false} autoComplete="email" textContentType="username" />
      <Input placeholder="Password (10+ characters, Aa, 1)" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" onSubmitEditing={submit} returnKeyType="go" />
      {!!err && <Text style={ui.error}>{err}</Text>}
      <Button title="Create account" onPress={submit} busy={busy} />
      <LinkText onPress={() => router.replace('/login')}>Already have an account? Log in</LinkText>
    </AuthScreen>
  );
}
