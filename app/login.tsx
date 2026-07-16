import { useState } from 'react';
import { Redirect } from 'expo-router';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSession } from '@/session/SessionContext';

export default function Login() {
  const { status, login } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (status === 'authenticated') return <Redirect href="/profile" />;

  async function submit() {
    if (!username.trim() || !password) return setError('Användarnamn och lösenord krävs.');
    setBusy(true); setError('');
    try { await login(username.trim(), password); }
    catch (e) { setError(e instanceof Error ? e.message : 'Inloggningen misslyckades.'); }
    finally { setBusy(false); }
  }

  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.page}>
    <View style={styles.card}>
      <Text style={styles.title}>No-Comment STC</Text>
      <Text style={styles.subtitle}>Logga in på ditt eget STC/BRP-konto.</Text>
      <TextInput autoCapitalize="none" autoCorrect={false} placeholder="Användarnamn" value={username} onChangeText={setUsername} style={styles.input} />
      <TextInput autoCapitalize="none" placeholder="Lösenord" secureTextEntry value={password} onChangeText={setPassword} style={styles.input} />
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <Pressable disabled={busy} onPress={submit} style={[styles.button, busy && styles.disabled]}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Logga in</Text>}</Pressable>
      <Text style={styles.note}>Lösenordet sparas aldrig. Tokens lagras i enhetens säkra nyckellager.</Text>
    </View>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({ page:{flex:1,justifyContent:'center',padding:24,backgroundColor:'#eef2ff'},card:{gap:14,padding:24,borderRadius:20,backgroundColor:'#fff'},title:{fontSize:30,fontWeight:'700'},subtitle:{color:'#475569',marginBottom:8},input:{borderWidth:1,borderColor:'#cbd5e1',borderRadius:10,padding:14,fontSize:16},button:{alignItems:'center',padding:15,borderRadius:10,backgroundColor:'#4338ca'},disabled:{opacity:.6},buttonText:{color:'#fff',fontWeight:'700'},error:{color:'#b91c1c'},note:{fontSize:12,color:'#64748b'}});
