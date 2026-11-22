import type { ReactNode } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type TextInputProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/lib/theme';

export function Brand({ size = 30 }: { size?: number }) {
  return (
    <Text style={[ui.brand, { fontSize: size }]}>
      travel<Text style={{ color: colors.accent }}>buddy</Text>
    </Text>
  );
}

// Shared frame for login, signup, confirm and reset.
export function AuthScreen({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={[ui.authBody, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Brand />
        <Text style={ui.title}>{title}</Text>
        {!!subtitle && <Text style={ui.muted}>{subtitle}</Text>}
        <View style={{ gap: 12, marginTop: 8 }}>{children}</View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function Input(props: TextInputProps) {
  return <TextInput placeholderTextColor={colors.muted} keyboardAppearance="dark" {...props} style={[ui.input, props.style]} />;
}

export function Button({ title, onPress, busy, disabled, kind = 'primary' }: { title: string; onPress: () => void; busy?: boolean; disabled?: boolean; kind?: 'primary' | 'plain' | 'danger' }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [ui.button, ui[kind], (disabled || busy) && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}
    >
      {busy ? <ActivityIndicator color={kind === 'primary' ? colors.bg : colors.text} /> : <Text style={[ui.buttonText, kind === 'primary' && { color: colors.bg }]}>{title}</Text>}
    </Pressable>
  );
}

export function LinkText({ children, onPress }: { children: ReactNode; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={{ alignSelf: 'center', padding: 8 }}>
      <Text style={ui.link}>{children}</Text>
    </Pressable>
  );
}

export const ui = StyleSheet.create({
  brand: { color: colors.text, fontWeight: '800', letterSpacing: -0.5 },
  authBody: { paddingHorizontal: 24, gap: 10, flexGrow: 1 },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', marginTop: 24 },
  muted: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  error: { color: colors.rec, fontSize: 14 },
  input: { backgroundColor: colors.surface, color: colors.text, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, borderWidth: 1, borderColor: colors.line },
  button: { borderRadius: 14, paddingVertical: 15, alignItems: 'center', justifyContent: 'center', minHeight: 52 },
  primary: { backgroundColor: colors.accent },
  plain: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  danger: { backgroundColor: 'rgba(255,69,58,0.15)', borderWidth: 1, borderColor: colors.rec },
  buttonText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  link: { color: colors.muted, fontSize: 15 },
});
