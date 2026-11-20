import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import { colors } from '@/lib/theme';
import '@/lib/backgroundTrack'; // defines the background location task before the OS can wake it

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
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="trips" options={{ title: 'Trips' }} />
        <Stack.Screen name="trip/[id]" options={{ title: 'Trip' }} />
      </Stack>
    </>
  );
}
