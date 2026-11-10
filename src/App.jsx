import React, {useCallback, useEffect, useRef, useState} from 'react';
import {NavLink, Routes, Route, useNavigate} from 'react-router-dom';
import {Home, Search, Library, Plus, Heart, Bell, ChevronDown, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, ListMusic, Volume2, MoreHorizontal, Headphones, ArrowLeft, X, Download, CirclePlus, Disc3, Radio, UserRound, Clock3, Sparkles, Menu, Grip, Check, Moon, SlidersHorizontal, Music2, AudioLines, Compass, CircleUserRound, CreditCard, Crown} from 'lucide-react';
import { getPreferences, login as apiLogin, registerAccount, logout as apiLogout, restoreSession, saveActiveLounge } from './api/client.js';
import AccountPage from './components/AccountPage.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import CatalogSearchPage from './components/CatalogSearchPage.jsx';
import LiveQueuePage from './components/LiveQueuePage.jsx';
import ConnectedPlayer from './components/ConnectedPlayer.jsx';
import PodcastBrowse from './components/PodcastBrowse.jsx';
import NowPlayingPage from './components/NowPlayingPage.jsx';
import RecommendationShelf from './components/RecommendationShelf.jsx';
import { getPopularAlbums, searchTracks } from './api/client.js';
import { formatTrackDuration, groupCatalogArtists, toPlayerTrack } from './api/catalogData.js';
import { STARTER_PLAYLISTS, mergeStarterPlaylists } from './api/starterPlaylists.js';
import { CatalogAlbumPage, CatalogArtistPage, CatalogPlaylistPage } from './components/CatalogPages.jsx';
import AdminAcousticProfilePage from './components/AdminAcousticProfilePage.jsx';
import AiDJPage from './components/AiDJPage.jsx';
import PlansPage from './components/PlansPage.jsx';
import BillingPage from './components/BillingPage.jsx';
import AdminBillingPage from './components/AdminBillingPage.jsx';
import { ArtistArtwork, TrackArtwork } from './components/CatalogArtwork.jsx';
import { radioStations } from './api/radioStations.js';
const img=(id,w=500)=>`https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=85`;
const pages=[['Home',Home,'/'],['Search',Search,'/search'],['Your Library',Library,'/playlist'],['AI DJ',Headphones,'/ai-dj']];
const starterPlaylists=STARTER_PLAYLISTS;
function Cover({id,size='cover',className=''}){return <img className={`cover ${className}`} src={img(id)} alt=""/>}
function App(){
 const [playing,setPlaying]=useState(false),[liked,setLiked]=useState(false),[track,setTrack]=useState(null),[search,setSearch]=useState(''),[query,setQuery]=useState('');
 const [user,setUser]=useState(null),[sessionStatus,setSessionStatus]=useState('loading'),[authError,setAuthError]=useState(''),[notificationsOpen,setNotificationsOpen]=useState(false);
 const [localPlaylists,setLocalPlaylists]=useState([]),[localPlaylistsLoaded,setLocalPlaylistsLoaded]=useState(false),[createPlaylistOpen,setCreatePlaylistOpen]=useState(false),[playlistError,setPlaylistError]=useState('');
 const [audioTime,setAudioTime]=useState(0),[audioDuration,setAudioDuration]=useState(0),[audioStatus,setAudioStatus]=useState('idle');
 const [audioPreferences,setAudioPreferences]=useState(null);
 const playbackToggleRef=useRef(null),playbackSeekRef=useRef(null);
 const navigate=useNavigate();
 const playlistStorageKey=`astradj:local-playlists:${user?.id ?? 'guest'}`;
 useEffect(()=>{let active=true;restoreSession().then((account)=>{if(active){setUser(account);setSessionStatus('ready')}});return()=>{active=false}},[]);
 useEffect(()=>{setLocalPlaylistsLoaded(false);try{const saved=JSON.parse(localStorage.getItem(playlistStorageKey)??'[]');const result=mergeStarterPlaylists(Array.isArray(saved)?saved:[]);setLocalPlaylists(result.playlists);if(result.migrated)localStorage.setItem(playlistStorageKey,JSON.stringify(result.playlists))}catch{setLocalPlaylists(starterPlaylists)}finally{setLocalPlaylistsLoaded(true)}},[playlistStorageKey]);
 useEffect(()=>{let active=true;setAudioPreferences(null);if(!user?.id)return()=>{active=false};getPreferences().then(({preferences})=>{if(active)setAudioPreferences(preferences.audio)}).catch(()=>{if(active)setAudioPreferences(null)});return()=>{active=false}},[user?.id]);
 const onLogin=async(credentials)=>{const account=await apiLogin(credentials);setUser(account);setAuthError('')};
 const onRegister=async(accountData)=>{const account=await registerAccount(accountData);setUser(account);setAuthError('')};
 const onLogout=async()=>{try{await apiLogout()}finally{saveActiveLounge(null);setUser(null);setPlaying(false);setAuthError('')}};
 const playSong=(selected, autoplay=false)=>{setTrack(selected);setLiked(false);setPlaying(autoplay);setAudioTime(0);setAudioDuration(0);setAudioStatus(selected?.audioAssetUrl?'loading':'unavailable')};
 const registerPlaybackToggle=useCallback((toggle)=>{playbackToggleRef.current=toggle},[]);
 const registerPlaybackSeek=useCallback((seek)=>{playbackSeekRef.current=seek},[]);
 const seekPlayback=(seconds)=>playbackSeekRef.current?.(seconds);
 const togglePlayback=()=>{if(playbackToggleRef.current)return playbackToggleRef.current();if(!track?.audioAssetUrl){setAudioStatus('unavailable');return}setPlaying((current)=>!current)};
 const createPlaylist=(name)=>{const playlist={id:globalThis.crypto?.randomUUID?.()??`playlist-${Date.now()}`,name:name.trim(),trackIds:[],createdAt:new Date().toISOString()};const next=[...localPlaylists,playlist];try{localStorage.setItem(playlistStorageKey,JSON.stringify(next));setLocalPlaylists(next);setCreatePlaylistOpen(false);setPlaylistError('');navigate(`/playlist?playlist=${encodeURIComponent(playlist.id)}`);return true}catch{setPlaylistError('This browser could not save the playlist. Check available local storage and try again.');return false}};
 const changePlaylistTrack=(playlistId,trackId,add)=>{const next=localPlaylists.map((item)=>{if(item.id!==playlistId)return item;const ids=new Set(item.trackIds??[]);if(add)ids.add(trackId);else ids.delete(trackId);return {...item,trackIds:[...ids]}});try{localStorage.setItem(playlistStorageKey,JSON.stringify(next));setLocalPlaylists(next);setPlaylistError('');return true}catch{setPlaylistError('This browser could not save the playlist update.');return false}};
 return <div className="shell">
  <aside className="sidebar"><NavLink to="/" className="brand"><span className="brand-orbit"><AudioLines size={23}/></span><b>Astra<span>DJ</span></b></NavLink><nav className="side-nav">{pages.slice(0,2).map(([n,I,p])=><NavLink key={n} to={p} className={({isActive})=>`nav-item ${isActive?'active':''}`}><I size={16}/>{n}</NavLink>)}<NavLink to="/playlist" className="nav-item"><Library size={16}/>Your Library</NavLink><NavLink to="/plans" className="nav-item"><Crown size={16}/>Premium</NavLink>{user?.role === 'Admin' && <><NavLink to="/admin/acoustic" className="nav-item"><Music2 size={16}/>Acoustic Profiles</NavLink><NavLink to="/admin/billing" className="nav-item"><CreditCard size={16}/>Subscription Admin</NavLink></>}<button type="button" className="nav-item" onClick={()=>{setPlaylistError('');setCreatePlaylistOpen(true)}}><Plus size={16}/>Create Playlist</button><NavLink to="/profile" className="nav-item"><Heart size={16}/>Liked Songs</NavLink></nav><div className="side-divider"/><p className="eyebrow side-label">Playlists</p>{localPlaylists.map((item)=><NavLink to={`/playlist?playlist=${encodeURIComponent(item.id)}`} className="playlist-link" key={item.id}><Disc3 size={14}/>{item.name}</NavLink>)}<button type="button" className="new-playlist" onClick={()=>{setPlaylistError('');setCreatePlaylistOpen(true)}}><Plus size={15}/>New Playlist</button><div className="side-bottom"><span className="live-dot"/>Your sound, in orbit.</div></aside>
   <main className="main-area"><header className="topbar"><button className="mobile-menu"><Menu size={19}/></button><div className="searchbar"><Search size={15}/><input placeholder="Search songs, artists, or genres..." value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>e.key==='Enter'&&(setQuery(search),navigate('/search'))}/>{search&&<button onClick={()=>setSearch('')}><X size={14}/></button>}</div><div className="top-actions"><NavLink to="/plans" className="premium-top-link" aria-label="View Premium plans"><Crown size={14}/><span>Premium</span></NavLink><div className="notification-wrap"><button type="button" className="icon-btn notification-button" aria-label="Notifications" aria-expanded={notificationsOpen} aria-controls="notification-panel" onClick={()=>setNotificationsOpen((open)=>!open)}><Bell size={17}/></button>{notificationsOpen&&<section className="notification-panel" id="notification-panel" aria-label="Notifications"><div className="notification-panel-heading"><b>Notifications</b><button type="button" aria-label="Close notifications" onClick={()=>setNotificationsOpen(false)}><X size={15}/></button></div><div className="notification-empty" role="status"><span className="notification-empty-icon"><Bell size={18}/></span><b>You’re all caught up</b><small>No notifications are available yet.</small></div></section>}</div><NavLink to="/profile" className="user-pill"><Cover id="photo-1506794778202-cad84cf45f1d"/><span>{user?.displayName?.split(' ')[0] ?? 'Sign in'}</span><ChevronDown size={12}/></NavLink></div></header>
  <div className="mobile-brand"><span className="brand-orbit"><AudioLines size={18}/></span><b>Astra<span>DJ</span></b></div>
  <Routes><Route path="/" element={<HomePage playSong={playSong} user={user}/>} /><Route path="/podcasts" element={<HomePage playSong={playSong} user={user} view="podcasts" track={track} playing={playing}/>} /><Route path="/radio" element={<HomePage playSong={playSong} user={user} view="radio" track={track} playing={playing} onToggle={togglePlayback}/>} /><Route path="/ai-dj" element={<AiPage user={user} trackId={['radio','podcast'].includes(track?.kind) ? undefined : track?.trackId} currentTime={audioTime} aiDjCommentary={audioPreferences?.aiDjCommentary !== false}/>} /><Route path="/now-playing" element={<NowPlayingPage playSong={playSong} track={track} playing={playing} onToggle={togglePlayback} onSeek={seekPlayback} liked={liked} setLiked={setLiked} currentTime={audioTime} duration={audioDuration} audioStatus={audioStatus}/>} /><Route path="/search" element={<CatalogSearchPage query={query||search} playSong={playSong}/>} /><Route path="/playlist" element={<CatalogPlaylistPage playSong={playSong} playlists={localPlaylists} playlistsLoaded={localPlaylistsLoaded} onAddTrack={(playlistId,trackId)=>changePlaylistTrack(playlistId,trackId,true)} onRemoveTrack={(playlistId,trackId)=>changePlaylistTrack(playlistId,trackId,false)} playlistError={playlistError}/>} /><Route path="/queue" element={<LiveQueuePage track={['radio','podcast'].includes(track?.kind) ? null : track} currentTime={audioTime} duration={audioDuration} playing={playing} onCurrentTrack={playSong} onTransitionTrack={(song)=>playSong(song,true)} user={user} aiDjCommentary={audioPreferences?.aiDjCommentary !== false}/>} /><Route path="/artist" element={<CatalogArtistPage playSong={playSong}/>} /><Route path="/profile" element={<AccountPage user={user} sessionStatus={sessionStatus} onLogin={onLogin} onRegister={onRegister} onLogout={onLogout} authError={authError} playlists={localPlaylists} playlistsLoaded={localPlaylistsLoaded}/>} /><Route path="/album" element={<CatalogAlbumPage/>} /><Route path="/plans" element={<PlansPage user={user}/>} /><Route path="/settings/billing" element={<BillingPage user={user}/>} /><Route path="/settings" element={<SettingsPage user={user} onPreferencesChange={setAudioPreferences}/>} /><Route path="/admin/acoustic" element={<AdminAcousticProfilePage user={user} sessionStatus={sessionStatus}/>} /><Route path="/admin/billing" element={<AdminBillingPage user={user}/>} /><Route path="*" element={<HomePage playSong={playSong}/>} /></Routes></main>
  <ConnectedPlayer track={track} playing={playing} onToggle={togglePlayback} registerPlaybackToggle={registerPlaybackToggle} registerPlaybackSeek={registerPlaybackSeek} liked={liked} setLiked={setLiked} currentTime={audioTime} setCurrentTime={setAudioTime} duration={audioDuration} setDuration={setAudioDuration} setAudioStatus={setAudioStatus} onPlaybackChange={setPlaying}/><MobileNav/>{createPlaylistOpen&&<CreatePlaylistDialog onClose={()=>setCreatePlaylistOpen(false)} onCreate={createPlaylist} error={playlistError}/>}
 </div>
}
function SectionTitle({children,more}){return <div className="section-title"><h2>{children}</h2>{more&&<NavLink to={more==='See All'?'/artist':'/playlist'}>{more}</NavLink>}</div>}
function summarizeCatalogVibe(tracks){
 const profiles=tracks.map((track)=>track.acoustic).filter((profile)=>profile&&Number.isFinite(profile.bpm)&&profile.bpm>0&&Number.isFinite(profile.energy)&&profile.energy>=0&&profile.energy<=1&&Number.isFinite(profile.valence)&&profile.valence>=0&&profile.valence<=1);
 if(!profiles.length)return null;
 const energy=profiles.reduce((sum,profile)=>sum+profile.energy,0)/profiles.length;
 const valence=profiles.reduce((sum,profile)=>sum+profile.valence,0)/profiles.length;
 const bpm=profiles.reduce((sum,profile)=>sum+profile.bpm,0)/profiles.length;
 const label=energy>=.65?(valence>=.55?'Upbeat & energetic':'Driving & intense'):energy<.4?(valence>=.55?'Gentle & warm':'Calm & mellow'):valence>=.65?'Bright & balanced':valence<.4?'Moody & steady':'Balanced & steady';
 return{count:profiles.length,energy,valence,bpm,label};
}
function CreatePlaylistDialog({onClose,onCreate,error}){const [name,setName]=useState('');return <div className="playlist-dialog-backdrop"><section className="panel playlist-dialog" role="dialog" aria-modal="true" aria-labelledby="create-playlist-title"><div className="playlist-dialog-heading"><div><span className="eyebrow">YOUR LIBRARY</span><h2 id="create-playlist-title">Create playlist</h2></div><button type="button" className="icon-btn" aria-label="Close create playlist dialog" onClick={onClose}><X size={17}/></button></div><p>Start a new playlist and give it a name.</p><form onSubmit={(event)=>{event.preventDefault();onCreate(name)}}><label htmlFor="new-playlist-name">Playlist name</label><input id="new-playlist-name" autoFocus maxLength={60} required value={name} onChange={(event)=>setName(event.target.value)} placeholder="e.g. Late Night Focus"/><small>Playlists are saved in this browser only and aren’t synced to your account.</small>{error&&<div role="alert" className="integration-error">{error}</div>}<div className="playlist-dialog-actions"><button type="button" className="btn-outline" onClick={onClose}>Cancel</button><button type="submit" className="btn-primary" disabled={!name.trim()}><Plus size={14}/>Create Playlist</button></div></form></section></div>}
function HomePage({ playSong, user, view = 'music', track, playing, onToggle }) {
 const [catalog, setCatalog] = useState([]);
 const [catalogStatus, setCatalogStatus] = useState('loading');
 const [catalogError, setCatalogError] = useState('');
 const [catalogRefresh, setCatalogRefresh] = useState(0);
 const [popularAlbums, setPopularAlbums] = useState([]);
 const [popularAlbumsStatus, setPopularAlbumsStatus] = useState('loading');
 const [popularAlbumsError, setPopularAlbumsError] = useState('');
 const [popularAlbumsRefresh, setPopularAlbumsRefresh] = useState(0);
 useEffect(() => {
  if (view !== 'music') { setCatalogStatus('ready'); return undefined; }
  const controller = new AbortController();
  setCatalogStatus('loading');
  setCatalogError('');
  searchTracks('', controller.signal).then((response) => {
   setCatalog(Array.isArray(response.items) ? response.items : []);
   setCatalogStatus('ready');
  }).catch((error) => {
   if (error.name === 'AbortError') return;
   setCatalogError(error.message || 'The track catalog could not be loaded.');
   setCatalogStatus('error');
  });
  return () => controller.abort();
 }, [view, catalogRefresh]);
 useEffect(() => {
  if (view !== 'music') return undefined;
  const controller = new AbortController();
  setPopularAlbumsStatus('loading');
  getPopularAlbums(controller.signal).then((response) => {
   setPopularAlbums(Array.isArray(response.items) ? response.items : []);
   setPopularAlbumsError('');
   setPopularAlbumsStatus('ready');
  }).catch((error) => {
   if (error.name === 'AbortError') return;
   setPopularAlbumsError(error.message || 'The Apple Music album chart could not be loaded.');
   setPopularAlbumsStatus('error');
  });
  return () => controller.abort();
 }, [view, popularAlbumsRefresh]);
 const catalogArtists = groupCatalogArtists(catalog);
 const catalogTracks = catalog.slice(0, 5);
 const catalogVibe = summarizeCatalogVibe(catalog);
 return <div className="page home-page"><div className="home-tabs" role="navigation" aria-label="Home categories"><NavLink to="/" end className={({isActive})=>`home-tab ${isActive?'selected':''}`}>Music</NavLink><NavLink to="/podcasts" className={({isActive})=>`home-tab ${isActive?'selected':''}`}>Podcasts</NavLink><NavLink to="/queue" className={({isActive})=>`home-live-link home-tab ${isActive?'selected':''}`}>Live</NavLink><NavLink to="/radio" className={({isActive})=>`home-tab ${isActive?'selected':''}`}>Radio</NavLink></div>{view === 'podcasts' ? <PodcastBrowse playSong={playSong} track={track} playing={playing}/> : view === 'radio' ? <RadioBrowse playSong={playSong} track={track} playing={playing} onToggle={onToggle}/> : <div className="home-grid"><section className="home-primary"><div className="hero"><div className="hero-copy"><span className="ai-tag">✦ AI DJ</span><h1>Good Evening{user?.displayName ? `, ${user.displayName.split(' ')[0]}` : ''}! 👋</h1><p>Let me play something perfect<br/>for your current mood.</p><div className="hero-actions"><NavLink to="/ai-dj" className="btn-primary"><Play size={14} fill="currentColor"/>Start DJ Session</NavLink><NavLink to="/ai-dj#customize" className="btn-outline">Customize</NavLink></div></div><div className="hero-image"/></div>
  <div className="section-title"><h2>Artists in catalog</h2><NavLink to="/playlist">Browse tracks</NavLink></div>
  {catalogStatus === 'loading' && <div className="panel integration-status" role="status">Loading catalog artists…</div>}
  {catalogStatus === 'error' && <div className="panel integration-error" role="alert">{catalogError}</div>}
  {catalogStatus === 'ready' && !catalogArtists.length && <div className="panel integration-status">The connected catalog has no tracks to derive artists from. Populate the configured AstraDJ database, then reload. <NavLink to="/playlist" className="chart-retry">Open catalog</NavLink><button type="button" className="chart-retry" onClick={() => setCatalogRefresh((current) => current + 1)}>Retry</button></div>}
  {catalogStatus === 'ready' && catalogArtists.length > 0 && <div className="artist-row">{catalogArtists.slice(0, 6).map((artist) => <NavLink to={`/artist?name=${encodeURIComponent(artist.name)}`} className="artist-card" key={artist.name}><ArtistArtwork artist={artist.name}/><b>{artist.name}</b><small>{artist.tracks.length} {artist.tracks.length === 1 ? 'track' : 'tracks'}</small></NavLink>)}</div>}
  <RecommendationShelf user={user} onSelect={playSong}/><section className="home-albums" aria-labelledby="home-popular-albums"><div className="section-title"><h2 id="home-popular-albums">Popular albums · India</h2><small>Apple Music Most Played chart</small></div>{popularAlbumsStatus==='loading'&&<div className="panel integration-status" role="status">Loading the latest album chart…</div>}{popularAlbumsStatus==='error'&&<div className="panel integration-error" role="alert">{popularAlbumsError} <button type="button" className="chart-retry" onClick={()=>setPopularAlbumsRefresh((current)=>current+1)}>Try again</button></div>}{popularAlbumsStatus==='ready'&&popularAlbums.length===0&&<div className="panel integration-status">The chart source returned no albums right now.</div>}{popularAlbumsStatus==='ready'&&popularAlbums.length>0&&<><div className="popular-album-grid">{popularAlbums.map((album)=><a className="popular-album-card" href={album.appleMusicUrl} target="_blank" rel="noreferrer" key={album.albumId}><div className="popular-album-art"><img src={album.artworkUrl} alt="" loading="lazy"/><span>#{album.rank}</span></div><b title={album.title}>{album.title}</b><small title={album.artistName}>{album.artistName}</small>{album.genres.length>0&&<small className="popular-album-genre">{album.genres[0]}</small>}</a>)}</div><small className="album-chart-disclosure">Ranked by Apple Music India. Album links open Apple Music; AstraDJ does not host or play these recordings.</small></>}</section>
 </section><aside className="home-rail"><div className="vibe-card"><h3>{catalogStatus==='loading'?'Loading catalog vibe…':catalogStatus==='error'?'Catalog vibe unavailable':'Catalog vibe snapshot'}</h3>{catalogVibe?<div className="vibe-head"><div className="vibe-icon"><AudioLines size={21}/></div><div><b>{catalogVibe.label}</b><small>Estimated from {catalogVibe.count} catalog tracks with acoustic profiles.</small><small>Energy {catalogVibe.energy.toFixed(2)} · Valence {catalogVibe.valence.toFixed(2)} · {Math.round(catalogVibe.bpm)} BPM avg.</small></div></div>:<div className="vibe-head"><div className="vibe-icon"><AudioLines size={21}/></div><div><b>{catalogStatus==='loading'?'Reading saved acoustic profiles…':catalogStatus==='error'?'Catalog data could not be loaded':'No acoustic profiles yet'}</b><small>{catalogStatus==='error'?catalogError:'A catalog vibe summary appears when tracks have saved energy, valence, and BPM metadata.'}</small></div></div>}<NavLink className="vibe-cta" to="/ai-dj"><Sparkles size={14}/> Open AI DJ</NavLink><small className="vibe-disclosure">Catalog-level estimates, not your personal listening profile.</small></div>
  <div className="section-title"><h2>Catalog tracks</h2><NavLink to="/playlist">See all</NavLink></div>
  {catalogStatus === 'loading' && <div className="panel integration-status" role="status">Loading catalog tracks…</div>}
  {catalogStatus === 'error' && <div className="panel integration-error" role="alert">{catalogError}</div>}
  {catalogStatus === 'ready' && catalogTracks.length === 0 && <div className="panel integration-status">The connected catalog currently has no track records. Populate the configured AstraDJ database, then reload. <NavLink to="/playlist" className="chart-retry">Open catalog</NavLink><button type="button" className="chart-retry" onClick={() => setCatalogRefresh((current) => current + 1)}>Retry</button></div>}
  {catalogStatus === 'ready' && catalogTracks.length > 0 && <div className="trending-list">{catalogTracks.map((item, index) => <button type="button" className="trending-item" key={item.trackId} onClick={() => playSong(toPlayerTrack(item))}><span>{index + 1}</span><TrackArtwork track={item} className="catalog-cover"/><span><b>{item.title}</b><small>{item.artist} · {formatTrackDuration(item.durationSeconds)}</small></span><Play size={14}/></button>)}</div>}
  <div className="rail-ai"><Sparkles size={15}/><div><b>AI DJ preview</b><small>Join a Lounge to request grounded DJ tools.</small></div><NavLink to="/ai-dj">Try it <span>→</span></NavLink></div></aside></div>}</div>;
}
function RadioBrowse({ playSong, track, playing, onToggle }) {
 const activeRadio = track?.kind === 'radio';
 return <section className="radio-browse" aria-labelledby="radio-title">
  <div className="radio-heading"><span className="ai-tag">ASTRADJ RADIO</span><h1 id="radio-title">Radio</h1><p>Listen to stations that publish a playable public feed.</p></div>
  <div className="radio-station-grid">{radioStations.map((station) => {
   const selected = activeRadio && track.trackId === `radio-${station.stationId}`;
   return <article className={`panel radio-station-card ${selected ? 'radio-station-active' : ''}`} key={station.stationId}>
    <div className="radio-station-icon"><Radio size={27}/></div><div className="radio-station-info"><span className="eyebrow">LIVE · {station.format.toUpperCase()}</span><h2>{station.name}</h2><p>{station.description}</p><small>Stream and station details: <a href={station.websiteUrl} target="_blank" rel="noreferrer">station website</a></small></div>
    <button type="button" className={selected && playing ? 'btn-outline' : 'btn-primary'} onClick={() => { if (selected) onToggle?.(); else playSong({ trackId: `radio-${station.stationId}`, kind: 'radio', title: station.name, artist: 'Live radio', audioAssetUrl: station.streamUrl, coverImageUrl: null }, true); }}>
     {selected && playing ? <><Pause size={15} fill="currentColor"/>Pause</> : <><Play size={15} fill="currentColor"/>{selected ? 'Resume live stream' : 'Listen live'}</>}
    </button>
   </article>;
  })}</div>
  <p className="radio-attribution">TheRadio.CC stream and description are provided by <a href={radioStations[0].sourceUrl} target="_blank" rel="noreferrer">TheRadio.CC</a>. It describes its programming as Creative Commons and other freely licensed music. Stream availability and programming are controlled by the station.</p>
 </section>;
}
function AiPage(props){return <AiDJPage {...props}/>;}
function MobileNav(){return <nav className="mobile-nav">{[['Home',Home,'/'],['Search',Search,'/search'],['Premium',Crown,'/plans'],['Library',Library,'/playlist'],['AI DJ',Headphones,'/ai-dj']].map(([t,I,p])=><NavLink key={t} to={p} className={({isActive})=>isActive?'active':''}><I size={18}/><small>{t}</small></NavLink>)}</nav>}
export default App;
