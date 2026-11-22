import { useEffect } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import { colors } from '@/lib/theme';
import '@/lib/backgroundTrack'; // defines the background location task before the OS can wake it
import { AuthProvider, useAuth } from '@/lib/auth';
import { Brand } from '@/components/ui';

// Pull the latest pushed version right at launch so a deploy reaches the phone on the next open,
// not the one after. Skipped in development builds (they load JS from the dev server instead).
async function applyLatestUpdate() {
  if (__DEV__ || !Updates.isEnabled) return;
  const check = await Updates.checkForUpdateAsync();
  if (!check.isAvailable) return;
  await Updates.fetchUpdateAsync();
  await Updates.reloadAsync();
}

export default function RootLayout() {
  useEffect(() => {
    applyLatestUpdate().catch(() => {}); // offline on the road: keep running the version already on the phone
  }, []);

  return (
    <AuthProvider>
      <StatusBar style="light" />
      <Screens />
    </AuthProvider>
  );
}

// Signed out: only the account screens exist. Signed in: only the app.
function Screens() {
  const { status } = useAuth();
  if (status === 'loading')
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <Brand size={36} />
      </View>
    );

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Protected guard={status === 'out'}>
        <Stack.Screen name="login" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="signup" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="confirm" options={{ headerShown: false }} />
        <Stack.Screen name="reset" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={status === 'in'}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="trips" options={{ title: 'Trips' }} />
        <Stack.Screen name="trip/[id]" options={{ title: 'Trip' }} />
        <Stack.Screen name="account" options={{ title: 'Account' }} />
      </Stack.Protected>
    </Stack>
  );
}
