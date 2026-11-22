import { useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/theme';
import { Button, ui } from '@/components/ui';

export default function Account() {
  const { email, logout, deleteAccount } = useAuth();
  const [busy, setBusy] = useState<'out' | 'delete' | null>(null);
  const [err, setErr] = useState('');

  const confirmDelete = () =>
    Alert.alert(
      'Delete your account?',
      'This permanently deletes your account and every trip: routes, videos, snapshots and conversations. It cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete everything',
          style: 'destructive',
          onPress: async () => {
            setErr('');
            setBusy('delete');
            try {
              await deleteAccount();
            } catch (e) {
              setErr((e as Error).message || 'Could not delete the account. Try again.');
              setBusy(null);
            }
          },
        },
      ],
    );

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
      <View style={{ backgroundColor: colors.surface, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: colors.line }}>
        <Text style={[ui.muted, { fontSize: 13 }]}>Signed in as</Text>
        <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600', marginTop: 2 }}>{email ?? '…'}</Text>
      </View>
      <Button
        title="Log out"
        kind="plain"
        busy={busy === 'out'}
        onPress={async () => {
          setBusy('out');
          await logout();
        }}
      />
      <View style={{ height: 24 }} />
      <Button title="Delete account" kind="danger" busy={busy === 'delete'} onPress={confirmDelete} />
      {!!err && <Text style={ui.error}>{err}</Text>}
    </ScrollView>
  );
}
