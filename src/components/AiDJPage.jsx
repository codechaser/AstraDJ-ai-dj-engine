import React, { useEffect, useRef, useState } from 'react';
import { Clock3, Headphones, Mic } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import AiActions from './AiActions.jsx';
import RecommendationShelf from './RecommendationShelf.jsx';

function getSpeechRecognition() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export default function AiDJPage({ user, trackId, currentTime, aiDjCommentary }) {
  const location = useLocation();
  const [mood, setMood] = useState('Chill');
  const [voiceSupported] = useState(() => Boolean(getSpeechRecognition()));
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('');
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const recognitionRef = useRef(null);

  useEffect(() => {
    if (location.hash !== '#customize') return undefined;
    const frame = window.requestAnimationFrame(() => document.getElementById('ai-dj-moods')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash]);

  useEffect(() => () => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.abort?.();
  }, []);

  function toggleVoiceInput() {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setVoiceStatus('Voice input is not supported in this browser. Type a request instead.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      setVoiceListening(true);
      setVoiceTranscript('');
      setVoiceStatus('Listening… Speak your request.');
    };
    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim() ?? '';
      if (transcript) {
        setVoiceTranscript(transcript);
        setVoiceStatus('Speech captured. Review the request below, then press send.');
      } else {
        setVoiceStatus('No speech was recognized. Try again or type a request.');
      }
    };
    recognition.onerror = (event) => {
      setVoiceStatus(event.error === 'not-allowed'
        ? 'Microphone access was denied. Type a request instead.'
        : 'Voice input could not start. Check microphone access or type a request.');
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setVoiceListening(false);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setVoiceListening(false);
      setVoiceStatus('Voice input could not start. Try again or type a request.');
    }
  }

  return <div className="page ai-page">
    <div className="page-heading"><div><span className="eyebrow">ASTRA INTELLIGENCE</span><h1>Your Personal DJ</h1><p>A soundtrack that moves with you.</p></div><button className="btn-outline" disabled title="Session history is not available from the current API"><Clock3 size={15}/> History unavailable</button></div>
    <div className="ai-stage">
      <div className="ai-orbit"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="ai-face"><Headphones size={76}/><span className="equalizer"><i/><i/><i/><i/><i/></span></div><span className="spark spark-a">✦</span><span className="spark spark-b">✧</span></div>
      <span className="ai-tag">✦ ASTRA AI</span><h2>What are we feeling today?</h2><p>Based on your mood, activity and taste</p>
      <div id="ai-dj-moods" className="mood-chips" role="group" aria-label="Choose a mood">{['Chill', 'Workout', 'Focus', 'Party', 'Romantic'].map((item) => <button type="button" onClick={() => setMood(item)} className={mood === item ? 'selected' : ''} key={item}>{item}</button>)}</div>
      <button type="button" className={`mic-button ${voiceListening ? 'listening' : ''}`} disabled={!voiceSupported} aria-label={voiceListening ? 'Stop voice input' : 'Start voice input'} aria-pressed={voiceListening} title={voiceSupported ? 'Use your microphone to dictate a request' : 'Voice input is not supported in this browser'} onClick={toggleVoiceInput}><Mic size={25}/></button>
      <small className="tap-label" role="status">{voiceStatus || (voiceSupported ? 'Tap to speak' : 'Voice input is not supported here. Type a request below.')}</small>
      <AiActions user={user} trackId={trackId} currentTime={currentTime} embedded aiDjCommentary={aiDjCommentary} voiceTranscript={voiceTranscript}/>
    </div>
    <div className="ai-lower"><section className="panel"><div className="section-title"><h2>Session history</h2></div><div className="integration-status">Session history is not exposed by the current backend API.</div></section><section className="panel"><RecommendationShelf compact user={user}/></section></div>
  </div>;
}
