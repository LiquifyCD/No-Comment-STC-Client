import { Redirect } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSession } from '@/session/SessionContext';

export default function Profile() {
  const { status, profile, error, reloadProfile, logout } = useSession();
  if (status === 'anonymous') return <Redirect href="/login" />;
  if (status === 'loading') return <View style={styles.center}><ActivityIndicator /></View>;
  return <ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.title}>Min profil</Text>
    {!!error && <Text style={styles.error}>{error}</Text>}
    {profile ? Object.entries(profile).map(([key,value]) => <View key={key} style={styles.row}><Text style={styles.key}>{key}</Text><Text selectable style={styles.value}>{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')}</Text></View>) : <Text>Ingen profildata kunde visas.</Text>}
    <Pressable onPress={reloadProfile} style={styles.secondary}><Text>Uppdatera</Text></Pressable>
    <Pressable onPress={logout} style={styles.logout}><Text style={{color:'#fff'}}>Logga ut</Text></Pressable>
  </ScrollView>;
}
const styles=StyleSheet.create({page:{padding:24,gap:12,backgroundColor:'#f8fafc'},center:{flex:1,alignItems:'center',justifyContent:'center'},title:{fontSize:30,fontWeight:'700'},row:{padding:14,borderRadius:10,backgroundColor:'#fff'},key:{fontWeight:'700',marginBottom:4},value:{color:'#334155'},error:{color:'#b91c1c'},secondary:{alignItems:'center',padding:14,borderWidth:1,borderColor:'#cbd5e1',borderRadius:10},logout:{alignItems:'center',padding:14,borderRadius:10,backgroundColor:'#b91c1c'}});
