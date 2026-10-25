import React, {useCallback, useEffect, useRef, useState} from 'react';
import {NavLink, Routes, Route, useNavigate} from 'react-router-dom';
import {Home, Search, Library, Plus, Heart, Bell, ChevronDown, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, ListMusic, Volume2, MoreHorizontal, Headphones, Mic2, ArrowLeft, X, Download, CirclePlus, Disc3, Radio, Podcast, UserRound, Clock3, Sparkles, Mic, Send, Menu, Grip, Check, Moon, SlidersHorizontal, Music2, AudioLines, Compass, CircleUserRound} from 'lucide-react';
import { getPreferences, login as apiLogin, registerAccount, logout as apiLogout, restoreSession, saveActiveLounge } from './api/client.js';
import AccountPage from './components/AccountPage.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import CatalogSearchPage from './components/CatalogSearchPage.jsx';
import LiveQueuePage from './components/LiveQueuePage.jsx';
import ConnectedPlayer from './components/ConnectedPlayer.jsx';
import NowPlayingPage from './components/NowPlayingPage.jsx';
import AiActions from './components/AiActions.jsx';
import RecommendationShelf from './components/RecommendationShelf.jsx';
import { searchTracks } from './api/client.js';
import { formatTrackDuration, groupCatalogArtists, toPlayerTrack } from './api/catalogData.js';
import { CatalogAlbumPage, CatalogArtistPage, CatalogPlaylistPage } from './components/CatalogPages.jsx';
import AdminAcousticProfilePage from './components/AdminAcousticProfilePage.jsx';
const img=(id,w=500)=>`https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=85`;
const pages=[['Home',Home,'/'],['Search',Search,'/search'],['Your Library',Library,'/playlist'],['AI DJ',Headphones,'/ai-dj']];
function Cover({id,size='cover',className=''}){return <img className={`cover ${className}`} src={img(id)} alt=""/>}
function App(){
 const [playing,setPlaying]=useState(false),[liked,setLiked]=useState(false),[track,setTrack]=useState(null),[search,setSearch]=useState(''),[query,setQuery]=useState('');
 const [user,setUser]=useState(null),[sessionStatus,setSessionStatus]=useState('loading'),[authError,setAuthError]=useState('');
 const [audioTime,setAudioTime]=useState(0),[audioDuration,setAudioDuration]=useState(0),[audioStatus,setAudioStatus]=useState('unavailable');
 const [audioPreferences,setAudioPreferences]=useState(null);
 const playbackToggleRef=useRef(null);
 const navigate=useNavigate();
 useEffect(()=>{let active=true;restoreSession().then((account)=>{if(active){setUser(account);setSessionStatus('ready')}});return()=>{active=false}},[]);
 useEffect(()=>{let active=true;setAudioPreferences(null);if(!user?.id)return()=>{active=false};getPreferences().then(({preferences})=>{if(active)setAudioPreferences(preferences.audio)}).catch(()=>{if(active)setAudioPreferences(null)});return()=>{active=false}},[user?.id]);
 const onLogin=async(credentials)=>{const account=await apiLogin(credentials);setUser(account);setAuthError('')};
 const onRegister=async(accountData)=>{const account=await registerAccount(accountData);setUser(account);setAuthError('')};
 const onLogout=async()=>{try{await apiLogout()}finally{saveActiveLounge(null);setUser(null);setPlaying(false);setAuthError('')}};
 const playSong=(selected, autoplay=false)=>{setTrack(selected);setLiked(false);setPlaying(autoplay);setAudioTime(0);setAudioDuration(0);setAudioStatus(selected?.audioAssetUrl?'loading':'unavailable')};
 const registerPlaybackToggle=useCallback((toggle)=>{playbackToggleRef.current=toggle},[]);
 const togglePlayback=()=>{if(playbackToggleRef.current)return playbackToggleRef.current();if(!track?.audioAssetUrl){setAudioStatus('unavailable');return}setPlaying((current)=>!current)};
 return <div className="shell">
  <aside className="sidebar"><NavLink to="/" className="brand"><span className="brand-orbit"><AudioLines size={23}/></span><b>Astra<span>DJ</span></b></NavLink><nav className="side-nav">{pages.slice(0,2).map(([n,I,p])=><NavLink key={n} to={p} className={({isActive})=>`nav-item ${isActive?'active':''}`}><I size={16}/>{n}</NavLink>)}<NavLink to="/playlist" className="nav-item"><Library size={16}/>Your Library</NavLink>{user?.role === 'Admin' && <NavLink to="/admin/acoustic" className="nav-item"><Music2 size={16}/>Acoustic Profiles</NavLink>}<button className="nav-item"><Plus size={16}/>Create Playlist</button><NavLink to="/profile" className="nav-item"><Heart size={16}/>Liked Songs</NavLink></nav><div className="side-divider"/><p className="eyebrow side-label">Playlists</p>{['Chill Mix','Workout Mix','Lo-fi Beats','Focus Mode','Party Hits'].map((x,i)=><NavLink to="/playlist" className="playlist-link" key={x}><Disc3 size={14}/>{x}</NavLink>)}<NavLink to="/playlist" className="new-playlist"><Plus size={15}/>New Playlist</NavLink><div className="side-bottom"><span className="live-dot"/>Your sound, in orbit.</div></aside>
  <main className="main-area"><header className="topbar"><button className="mobile-menu"><Menu size={19}/></button><div className="searchbar"><Search size={15}/><input placeholder="Search songs, artists, or genres..." value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>e.key==='Enter'&&(setQuery(search),navigate('/search'))}/>{search&&<button onClick={()=>setSearch('')}><X size={14}/></button>}</div><div className="top-actions"><button className="icon-btn"><Bell size={17}/></button><NavLink to="/profile" className="user-pill"><Cover id="photo-1506794778202-cad84cf45f1d"/><span>{user?.displayName?.split(' ')[0] ?? 'Sign in'}</span><ChevronDown size={12}/></NavLink></div></header>
  <div className="mobile-brand"><span className="brand-orbit"><AudioLines size={18}/></span><b>Astra<span>DJ</span></b></div>
  <Routes><Route path="/" element={<HomePage playSong={playSong} user={user}/>} /><Route path="/ai-dj" element={<AiPage user={user} trackId={track?.trackId} currentTime={audioTime} aiDjCommentary={audioPreferences?.aiDjCommentary !== false}/>} /><Route path="/now-playing" element={<NowPlayingPage track={track} playing={playing} onToggle={togglePlayback} liked={liked} setLiked={setLiked} currentTime={audioTime} duration={audioDuration} audioStatus={audioStatus}/>} /><Route path="/search" element={<CatalogSearchPage query={query||search} playSong={playSong}/>} /><Route path="/playlist" element={<CatalogPlaylistPage playSong={playSong}/>} /><Route path="/queue" element={<LiveQueuePage track={track} currentTime={audioTime} duration={audioDuration} playing={playing} onCurrentTrack={playSong} onTransitionTrack={(song)=>playSong(song,true)} user={user} aiDjCommentary={audioPreferences?.aiDjCommentary !== false}/>} /><Route path="/artist" element={<CatalogArtistPage playSong={playSong}/>} /><Route path="/profile" element={<AccountPage user={user} sessionStatus={sessionStatus} onLogin={onLogin} onRegister={onRegister} onLogout={onLogout} authError={authError}/>} /><Route path="/album" element={<CatalogAlbumPage/>} /><Route path="/settings" element={<SettingsPage user={user} onPreferencesChange={setAudioPreferences}/>} /><Route path="/admin/acoustic" element={<AdminAcousticProfilePage user={user} sessionStatus={sessionStatus}/>} /><Route path="*" element={<HomePage playSong={playSong}/>} /></Routes></main>
  <ConnectedPlayer track={track} playing={playing} onToggle={togglePlayback} registerPlaybackToggle={registerPlaybackToggle} liked={liked} setLiked={setLiked} currentTime={audioTime} setCurrentTime={setAudioTime} setDuration={setAudioDuration} setAudioStatus={setAudioStatus} onPlaybackChange={setPlaying}/><MobileNav/>
 </div>
}
function SectionTitle({children,more}){return <div className="section-title"><h2>{children}</h2>{more&&<NavLink to={more==='See All'?'/artist':'/playlist'}>{more}</NavLink>}</div>}
function HomePage({ playSong, user }) {
 const [catalog, setCatalog] = useState([]);
 const [catalogStatus, setCatalogStatus] = useState('loading');
 const [catalogError, setCatalogError] = useState('');
 useEffect(() => {
  const controller = new AbortController();
  searchTracks('', controller.signal).then((response) => {
   setCatalog(Array.isArray(response.items) ? response.items : []);
   setCatalogStatus('ready');
  }).catch((error) => {
   if (error.name === 'AbortError') return;
   setCatalogError(error.message || 'The track catalog could not be loaded.');
   setCatalogStatus('error');
  });
  return () => controller.abort();
 }, []);
 const catalogArtists = groupCatalogArtists(catalog);
 const catalogTracks = catalog.slice(0, 5);
 return <div className="page home-page"><div className="home-tabs"><button className="selected">Music</button><button>Podcasts</button><NavLink className="home-live-link" to="/queue">Live</NavLink><button>Radio</button></div><div className="home-grid"><section className="home-primary"><div className="hero"><div className="hero-copy"><span className="ai-tag">✦ AI DJ</span><h1>Good Evening{user?.displayName ? `, ${user.displayName.split(' ')[0]}` : ''}! 👋</h1><p>Let me play something perfect<br/>for your current mood.</p><div className="hero-actions"><NavLink to="/ai-dj" className="btn-primary"><Play size={14} fill="currentColor"/>Start DJ Session</NavLink><button className="btn-outline">Customize</button></div></div><div className="hero-image"/></div>
  <div className="section-title"><h2>Artists in catalog</h2><NavLink to="/playlist">Browse tracks</NavLink></div>
  {catalogStatus === 'loading' && <div className="panel integration-status" role="status">Loading catalog artists…</div>}
  {catalogStatus === 'error' && <div className="panel integration-error" role="alert">{catalogError}</div>}
  {catalogStatus === 'ready' && !catalogArtists.length && <div className="panel integration-status">No artists are available in the catalog yet.</div>}
  {catalogStatus === 'ready' && catalogArtists.length > 0 && <div className="artist-row">{catalogArtists.slice(0, 6).map((artist) => <NavLink to={`/artist?name=${encodeURIComponent(artist.name)}`} className="artist-card" key={artist.name}><div className="catalog-artist-art" aria-hidden="true"/><b>{artist.name}</b><small>{artist.tracks.length} {artist.tracks.length === 1 ? 'track' : 'tracks'}</small></NavLink>)}</div>}
  <div className="section-title"><h2>Recommended for you</h2></div><RecommendationShelf user={user} onSelect={playSong}/>
 </section><aside className="home-rail"><div className="vibe-card"><h3>Vibe profile unavailable</h3><div className="vibe-head"><div className="catalog-cover" aria-hidden="true"/><div><b>No mood profile yet</b><small>The catalog has no genre or mood fields.</small></div></div><NavLink className="vibe-cta" to="/ai-dj"><Sparkles size={14}/> Open AI DJ</NavLink></div>
  <div className="section-title"><h2>Catalog tracks</h2><NavLink to="/playlist">See all</NavLink></div>
  {catalogStatus === 'loading' && <div className="panel integration-status" role="status">Loading catalog tracks…</div>}
  {catalogStatus === 'error' && <div className="panel integration-error" role="alert">{catalogError}</div>}
  {catalogStatus === 'ready' && catalogTracks.length === 0 && <div className="panel integration-status">No tracks are available in the catalog yet.</div>}
  {catalogStatus === 'ready' && catalogTracks.length > 0 && <div className="trending-list">{catalogTracks.map((item, index) => <button type="button" className="trending-item" key={item.trackId} onClick={() => playSong(toPlayerTrack(item))}><span>{index + 1}</span><span className="catalog-cover" aria-hidden="true"/><span><b>{item.title}</b><small>{item.artist} · {formatTrackDuration(item.durationSeconds)}</small></span><Play size={14}/></button>)}</div>}
  <div className="rail-ai"><Sparkles size={15}/><div><b>AI DJ preview</b><small>Join a Lounge to request grounded DJ tools.</small></div><NavLink to="/ai-dj">Try it <span>→</span></NavLink></div></aside></div></div>;
}
function AiPage({user,trackId,currentTime,aiDjCommentary}){const [mood,setMood]=useState('Chill');return <div className="page ai-page"><div className="page-heading"><div><span className="eyebrow">ASTRA INTELLIGENCE</span><h1>Your Personal DJ</h1><p>A soundtrack that moves with you.</p></div><button className="btn-outline" disabled title="Session history is not available from the current API"><Clock3 size={15}/> History unavailable</button></div><div className="ai-stage"><div className="ai-orbit"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="ai-face"><Headphones size={76}/><span className="equalizer"><i/><i/><i/><i/><i/></span></div><span className="spark spark-a">✦</span><span className="spark spark-b">✧</span></div><span className="ai-tag">✦ ASTRA AI</span><h2>What are we feeling today?</h2><p>Based on your mood, activity and taste</p><div className="mood-chips">{['Chill','Workout','Focus','Party','Romantic'].map(m=><button onClick={()=>setMood(m)} className={mood===m?'selected':''} key={m}>{m}</button>)}</div><button className="mic-button" disabled aria-label="Voice input unavailable"><Mic size={25}/></button><small className="tap-label">Voice input unavailable</small><AiActions user={user} trackId={trackId} currentTime={currentTime} embedded aiDjCommentary={aiDjCommentary}/></div><div className="ai-lower"><section className="panel"><SectionTitle>Session history</SectionTitle><div className="integration-status">Session history is not exposed by the current backend API.</div></section><section className="panel"><SectionTitle>Picked for your taste</SectionTitle><RecommendationShelf compact user={user}/></section></div></div>}
function MobileNav(){return <nav className="mobile-nav">{[['Home',Home,'/'],['Search',Search,'/search'],['Library',Library,'/playlist'],['AI DJ',Headphones,'/ai-dj']].map(([t,I,p])=><NavLink key={t} to={p} className={({isActive})=>isActive?'active':''}><I size={18}/><small>{t}</small></NavLink>)}</nav>}
export default App;
