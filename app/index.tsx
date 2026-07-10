import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useSession } from '@/session/SessionContext';

export default function Index() {
  const { status } = useSession();
  if (status === 'loading') return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator /></View>;
  return <Redirect href={status === 'authenticated' ? '/profile' : '/login'} />;
}
