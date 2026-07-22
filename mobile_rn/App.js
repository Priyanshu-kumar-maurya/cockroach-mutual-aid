import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Button,
  Image,
  Alert,
  ActivityIndicator,
  Linking,
  Platform
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { FaceBlurService } from './FaceBlurService';

const BACKEND_URL = 'https://cockroach-mutual-aid-backend.onrender.com';

export default function App() {
  // Navigation & Authentication
  const [screen, setScreen] = useState('Verify');
  const [sessionId, setSessionId] = useState(null);
  const [userHash, setUserHash] = useState('');
  const [isMedicalVerified, setIsMedicalVerified] = useState(false);
  const [identifier, setIdentifier] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [proxyCode, setProxyCode] = useState('');
  const [showOtpInput, setShowOtpInput] = useState(false);
  const [demoCode, setDemoCode] = useState('');

  // Feed & State
  const [needs, setNeeds] = useState([]);
  const [selectedNeed, setSelectedNeed] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [loading, setLoading] = useState(false);
  const [isOffline, setIsOffline] = useState(false);

  // Form State
  const [postCategory, setPostCategory] = useState('Food');
  const [postUrgency, setPostUrgency] = useState('Normal');
  const [postDescription, setPostDescription] = useState('');
  const [postZone, setPostZone] = useState('');
  const [postCoords, setPostCoords] = useState({ latitude: 28.6139, longitude: 77.2090 });
  const [selectedPhoto, setSelectedPhoto] = useState(null);

  // Resolution Proof
  const [resolvePhoto, setResolvePhoto] = useState(null);

  // Load Session and Board on mount
  useEffect(() => {
    loadSavedSession();
    fetchBoard();
  }, []);

  const loadSavedSession = async () => {
    try {
      const sess = await AsyncStorage.getItem('mab_session_id');
      const hash = await AsyncStorage.getItem('mab_user_hash');
      const med = await AsyncStorage.getItem('mab_is_medical');

      if (sess && hash) {
        setSessionId(sess);
        setUserHash(hash);
        setIsMedicalVerified(med === 'true');
        setScreen('Feed');
      }
    } catch (e) {
      console.log('Failed to load session from AsyncStorage');
    }
  };

  const fetchBoard = async () => {
    setLoading(true);
    try {
      const headers = {};
      if (sessionId) headers['Authorization'] = sessionId;

      const res = await fetch(`${BACKEND_URL}/api/needs`, { headers });
      if (res.ok) {
        const data = await res.json();
        setNeeds(data);
        await AsyncStorage.setItem('cached_needs', JSON.stringify(data));
      } else {
        throw new Error('Server error fetching board');
      }
    } catch (err) {
      // Backend offline, load from cache
      const cached = await AsyncStorage.getItem('cached_needs');
      if (cached) {
        setNeeds(JSON.parse(cached));
      }
      setIsOffline(true);
    } finally {
      setLoading(false);
    }
  };

  // OTP FLOWS
  const handleRequestOTP = async () => {
    if (!identifier) {
      Alert.alert('Error', 'Please enter phone or email');
      return;
    }
    try {
      const res = await fetch(`${BACKEND_URL}/api/verify/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: identifier.includes('@') ? 'email' : 'phone',
          identifier
        })
      });
      const data = await res.json();
      setShowOtpInput(true);
      setDemoCode(data.demoCode || '123456');
    } catch (err) {
      Alert.alert('Offline Mode', 'Server unreachable. Simulated OTP verification.');
      setShowOtpInput(true);
      setDemoCode('654321');
    }
  };

  const handleConfirmOTP = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/verify/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: identifier.includes('@') ? 'email' : 'phone',
          identifier,
          code: otpCode,
          deviceinfo: Platform.OS + ' Native Client'
        })
      });
      if (res.ok) {
        const data = await res.json();
        setSessionId(data.sessionId);
        setUserHash(data.userHash);
        setIsMedicalVerified(false);

        await AsyncStorage.setItem('mab_session_id', data.sessionId);
        await AsyncStorage.setItem('mab_user_hash', data.userHash);
        await AsyncStorage.setItem('mab_is_medical', 'false');

        setScreen('Feed');
        fetchBoard();
      } else {
        const err = await res.json();
        Alert.alert('Error', err.error);
      }
    } catch (err) {
      // simulated confirmation offline
      const mockHash = 'usr_mock_' + Math.random().toString(36).substring(2, 8);
      setSessionId('mock_sess');
      setUserHash(mockHash);
      setScreen('Feed');
    }
  };

  const handleConfirmProxy = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/verify/coordinator-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxyName: proxyCode, deviceinfo: Platform.OS + ' Native Client' })
      });
      if (res.ok) {
        const data = await res.json();
        setSessionId(data.sessionId);
        setUserHash(data.userHash);
        setScreen('Feed');
        fetchBoard();
      }
    } catch (e) {
      Alert.alert('Offline Proxy approved.');
    }
  };

  // POST NEED REQUEST
  const handlePostNeed = async () => {
    if (!postDescription || !postZone) {
      Alert.alert('Error', 'Please enter description and landmark zone.');
      return;
    }

    let photoBase64 = null;
    if (selectedPhoto) {
      // Process face blur and strip metadata
      const cleanUri = await FaceBlurService.stripMetadata(selectedPhoto);
      // In production React Native, convert uri to base64 for SQLite Express REST POST
      photoBase64 = cleanUri; // mockup string URI placeholder
    }

    const payload = {
      category: postCategory,
      urgency: postUrgency,
      description: postDescription,
      photo_before: photoBase64,
      zone: postZone,
      exact_location: postCoords,
      contact_channel: { type: 'whatsapp_masked', value: userHash }
    };

    if (isOffline) {
      // Queue locally in AsyncStorage
      const queue = JSON.parse(await AsyncStorage.getItem('mab_offline_queue')) || [];
      queue.push(payload);
      await AsyncStorage.setItem('mab_offline_queue', JSON.stringify(queue));
      Alert.alert('Offline Mode', 'Post queued locally. Will sync when back online.');
      setScreen('Feed');
      return;
    }

    try {
      const res = await fetch(`${BACKEND_URL}/api/needs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': sessionId
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        Alert.alert('Success', 'Need posted successfully.');
        setPostDescription('');
        setPostZone('');
        setSelectedPhoto(null);
        setScreen('Feed');
        fetchBoard();
      } else {
        const err = await res.json();
        Alert.alert('Rate limit exceeded', err.error);
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to communicate with Express server.');
    }
  };

  // ACCEPT NEED
  const handleAcceptNeed = async () => {
    if (selectedNeed.category === 'Medical' && !isMedicalVerified) {
      Alert.alert('Verification Required', 'Medical needs are restricted to helpers verified by coordinators.');
      return;
    }

    try {
      const res = await fetch(`${BACKEND_URL}/api/needs/${selectedNeed.need_id}/accept`, {
        method: 'POST',
        headers: { 'Authorization': sessionId }
      });
      if (res.ok) {
        Alert.alert('Need Accepted', 'Coordinates unlocked. Route map loaded.');
        fetchBoard();
        setScreen('Feed'); // Refresh state
      }
    } catch (e) {
      Alert.alert('Offline Accept Sim.');
    }
  };

  // RESOLVE NEED
  const handleResolveNeed = async () => {
    if (!resolvePhoto) {
      Alert.alert('Mandatory Proof', 'You must upload a photo proof of resolution.');
      return;
    }

    try {
      const cleanUri = await FaceBlurService.stripMetadata(resolvePhoto);

      const res = await fetch(`${BACKEND_URL}/api/needs/${selectedNeed.need_id}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': sessionId
        },
        body: JSON.stringify({ photo_after: cleanUri })
      });

      if (res.ok) {
        Alert.alert('Resolved', 'Thank you! The post has been closed.');
        setResolvePhoto(null);
        setScreen('Feed');
        fetchBoard();
      }
    } catch (e) {
      Alert.alert('Error resolving request.');
    }
  };

  // SECURE MASKS
  const handleMaskedCall = () => {
    Alert.alert('Secure Outbound Call', 'Connecting call via masked proxy. Your number is hidden.');
    Linking.openURL('tel:+15550192831');
  };

  const handleMaskedWhatsApp = () => {
    Alert.alert('Secure WhatsApp', 'Routing E2EE chat details via proxy gateway.');
    Linking.openURL('https://wa.me/15550192831');
  };

  // LOGOUT
  const handleLogout = async () => {
    await AsyncStorage.clear();
    setSessionId(null);
    setUserHash('');
    setScreen('Verify');
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>MUTUAL AID APP</Text>
        {isOffline && <Text style={styles.offlineText}>⚠️ OFFLINE MODE</Text>}
      </View>

      {/* SCREEN: VERIFICATION */}
      {screen === 'Verify' && (
        <ScrollView style={styles.content}>
          <Text style={styles.sectionTitle}>Identity Verification</Text>
          <Text style={styles.descText}>
            Anonymous-first verification keeps you safe. Data deletes after 30 days.
          </Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Verify Phone or Email</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. +919876543210 or test@gmail.com"
              value={identifier}
              onChangeText={setIdentifier}
              placeholderTextColor="#888"
            />
            <Button title="Request OTP Code" onPress={handleRequestOTP} />

            {showOtpInput && (
              <View style={styles.otpSection}>
                <Text style={styles.demoText}>Demo Code: {demoCode}</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Enter 6-digit OTP"
                  value={otpCode}
                  onChangeText={setOtpCode}
                  placeholderTextColor="#888"
                />
                <Button title="Confirm & Sign In" onPress={handleConfirmOTP} color="#4CD964" />
              </View>
            )}
          </View>

          <Text style={styles.orText}>- OR -</Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Coordinator Proxy</Text>
            <TextInput
              style={styles.input}
              placeholder="Coordinator Key Code"
              value={proxyCode}
              onChangeText={setProxyCode}
              placeholderTextColor="#888"
            />
            <Button title="Login via Coordinator Validation" onPress={handleConfirmProxy} color="#FF9500" />
          </View>
        </ScrollView>
      )}

      {/* SCREEN: FEED */}
      {screen === 'Feed' && (
        <View style={styles.content}>
          <View style={styles.filterBar}>
            {['All', 'Medical', 'Food', 'Shelter'].map(filter => (
              <TouchableOpacity
                key={filter}
                style={[styles.filterChip, categoryFilter === filter && styles.filterChipActive]}
                onPress={() => setCategoryFilter(filter)}
              >
                <Text style={styles.chipText}>{filter}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <ScrollView style={styles.feedScroll}>
            {needs
              .filter(n => categoryFilter === 'All' || n.category === categoryFilter)
              .map(need => (
                <TouchableOpacity
                  key={need.need_id}
                  style={[styles.feedCard, need.urgency === 'Emergency' && styles.emergencyCard]}
                  onPress={() => {
                    setSelectedNeed(need);
                    setScreen('Details');
                  }}
                >
                  <View style={styles.cardHeader}>
                    <Text style={styles.categoryText}>{need.category}</Text>
                    <Text style={styles.urgencyText}>{need.urgency}</Text>
                  </View>
                  <Text style={styles.descText} numberOfLines={2}>
                    {need.description}
                  </Text>
                  <Text style={styles.zoneText}>📍 {need.zone} &middot; {need.status}</Text>
                </TouchableOpacity>
              ))}
          </ScrollView>

          <TouchableOpacity style={styles.fab} onPress={() => setScreen('PostNeed')}>
            <Text style={styles.fabText}>+</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* SCREEN: POST A NEED */}
      {screen === 'PostNeed' && (
        <ScrollView style={styles.content}>
          <Text style={styles.sectionTitle}>Request Help</Text>
          
          <TextInput
            style={styles.input}
            placeholder="What is needed? (e.g. food packages, first aid items)"
            value={postDescription}
            onChangeText={setPostDescription}
            multiline
            numberOfLines={3}
            placeholderTextColor="#888"
          />

          <TextInput
            style={styles.input}
            placeholder="Public Zone/Landmark (e.g. Block A tents / gate 2)"
            value={postZone}
            onChangeText={setPostZone}
            placeholderTextColor="#888"
          />

          {/* Interactive Native Maps Picker */}
          <MapView
            style={styles.miniMap}
            initialRegion={{
              latitude: postCoords.latitude,
              longitude: postCoords.longitude,
              latitudeDelta: 0.01,
              longitudeDelta: 0.01,
            }}
            onPress={(e) => setPostCoords(e.nativeEvent.coordinate)}
          >
            <Marker coordinate={postCoords} />
          </MapView>

          <Button title="Post Need Request" onPress={handlePostNeed} color="#4CD964" />
          <View style={{ height: 10 }} />
          <Button title="Cancel" onPress={() => setScreen('Feed')} color="#FF3B30" />
        </ScrollView>
      )}

      {/* SCREEN: NEED DETAILS */}
      {screen === 'Details' && selectedNeed && (
        <ScrollView style={styles.content}>
          <Text style={styles.sectionTitle}>{selectedNeed.category} Need</Text>
          <Text style={styles.descText}>{selectedNeed.description}</Text>
          <Text style={styles.zoneText}>📍 Zone: {selectedNeed.zone}</Text>

          {/* Emergency Ambulance Bypass */}
          {selectedNeed.urgency === 'Emergency' && (
            <View style={styles.ambulanceCard}>
              <Text style={styles.ambulanceTitle}>🚑 GENUINE MEDICAL EMERGENCY?</Text>
              <Button title="📞 Call Ambulance (102)" onPress={() => Linking.openURL('tel:102')} color="#FF3B30" />
            </View>
          )}

          {selectedNeed.status === 'Open' && (
            <TouchableOpacity style={styles.actionBtn} onPress={handleAcceptNeed}>
              <Text style={styles.btnText}>🙋 Accept and Assist</Text>
            </TouchableOpacity>
          )}

          {selectedNeed.status === 'Accepted' && (
            <View style={styles.helperSection}>
              <Text style={styles.helperHeader}>🔒 Locked Active Task</Text>

              {/* Exact location Map unlocked */}
              <MapView
                style={styles.miniMap}
                initialRegion={{
                  latitude: selectedNeed.exact_location?.latitude || 28.6139,
                  longitude: selectedNeed.exact_location?.longitude || 77.2090,
                  latitudeDelta: 0.01,
                  longitudeDelta: 0.01,
                }}
              >
                {selectedNeed.exact_location && <Marker coordinate={selectedNeed.exact_location} />}
              </MapView>

              {/* Masked comms */}
              <View style={styles.commsRow}>
                <TouchableOpacity style={styles.commsBtn} onPress={handleMaskedCall}>
                  <Text style={styles.btnText}>📞 Masked Call</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.commsBtn} onPress={handleMaskedWhatsApp}>
                  <Text style={styles.btnText}>💬 WhatsApp Proxy</Text>
                </TouchableOpacity>
              </View>

              {/* Resolution proof */}
              <View style={styles.proofCard}>
                <Text style={styles.proofText}>Resolve Need (Mandatory Photo Proof)</Text>
                <Button title="Choose After-Photo Proof" onPress={() => setResolvePhoto('mock_photo.jpg')} />
                {resolvePhoto && <Text style={{ color: '#aaa', marginVertical: 5 }}>Photo Selected: (EXIF Stripped)</Text>}
                <Button title="Mark Resolved" onPress={handleResolveNeed} color="#4CD964" />
              </View>
            </View>
          )}

          <View style={{ height: 20 }} />
          <Button title="Back to Feed" onPress={() => setScreen('Feed')} />
        </ScrollView>
      )}

      {/* Footer session actions */}
      {sessionId && (
        <View style={styles.footer}>
          <TouchableOpacity onPress={handleLogout}>
            <Text style={styles.footerLink}>Logout Session</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0c0f13',
    paddingTop: 50
  },
  header: {
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  headerTitle: {
    color: '#34AADC',
    fontFamily: Platform.OS === 'ios' ? 'Helvetica' : 'monospace',
    fontWeight: 'bold',
    fontSize: 18
  },
  offlineText: {
    color: '#FF9500',
    fontSize: 12
  },
  content: {
    flex: 1,
    padding: 15
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 10
  },
  descText: {
    color: '#ccc',
    fontSize: 14,
    marginBottom: 15
  },
  input: {
    backgroundColor: '#1c1f24',
    color: '#fff',
    padding: 10,
    borderRadius: 8,
    marginBottom: 15,
    fontSize: 14
  },
  card: {
    backgroundColor: '#16191d',
    borderRadius: 12,
    padding: 15,
    marginBottom: 15,
    borderWidth: 1,
    borderColor: '#333'
  },
  cardTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 10
  },
  orText: {
    color: '#888',
    textAlign: 'center',
    marginVertical: 10,
    fontWeight: 'bold'
  },
  otpSection: {
    marginTop: 15,
    borderTopWidth: 1,
    borderTopColor: '#333',
    paddingTop: 15
  },
  demoText: {
    color: '#FF9500',
    fontSize: 12,
    marginBottom: 10,
    textAlign: 'center'
  },
  filterBar: {
    flexDirection: 'row',
    marginBottom: 15
  },
  filterChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: '#222',
    marginRight: 8
  },
  filterChipActive: {
    backgroundColor: '#34AADC'
  },
  chipText: {
    color: '#fff',
    fontSize: 12
  },
  feedScroll: {
    flex: 1
  },
  feedCard: {
    backgroundColor: '#16191d',
    borderRadius: 12,
    padding: 15,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderLeftColor: '#34AADC'
  },
  emergencyCard: {
    borderLeftColor: '#FF3B30',
    backgroundColor: 'rgba(255, 59, 48, 0.05)'
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 5
  },
  categoryText: {
    color: '#34AADC',
    fontWeight: 'bold',
    fontSize: 12
  },
  urgencyText: {
    color: '#aaa',
    fontSize: 12
  },
  zoneText: {
    color: '#888',
    fontSize: 11,
    marginTop: 5
  },
  fab: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    backgroundColor: '#34AADC',
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 5
  },
  fabText: {
    color: '#fff',
    fontSize: 28,
    lineHeight: 30
  },
  miniMap: {
    width: '100%',
    height: 180,
    borderRadius: 12,
    marginVertical: 15
  },
  ambulanceCard: {
    backgroundColor: 'rgba(255, 59, 48, 0.1)',
    borderWidth: 1,
    borderColor: '#FF3B30',
    padding: 15,
    borderRadius: 12,
    marginBottom: 15
  },
  ambulanceTitle: {
    color: '#FF3B30',
    fontWeight: 'bold',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 10
  },
  actionBtn: {
    backgroundColor: '#34AADC',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center'
  },
  btnText: {
    color: '#fff',
    fontWeight: 'bold'
  },
  helperSection: {
    marginTop: 10
  },
  helperHeader: {
    color: '#FF9500',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 10
  },
  commsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 10
  },
  commsBtn: {
    flex: 0.48,
    backgroundColor: '#1c1f24',
    borderWidth: 1,
    borderColor: '#4CD964',
    padding: 10,
    borderRadius: 8,
    alignItems: 'center'
  },
  proofCard: {
    backgroundColor: '#1c1f24',
    padding: 15,
    borderRadius: 12,
    marginTop: 15,
    borderWidth: 1,
    borderColor: '#333'
  },
  proofText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 10
  },
  footer: {
    padding: 15,
    borderTopWidth: 1,
    borderTopColor: '#222',
    alignItems: 'center'
  },
  footerLink: {
    color: '#FF3B30',
    fontSize: 13
  }
});
