const eventName='hv-audio-focus';
export function claimAudioFocus(owner){
  const releases=[];window.dispatchEvent(new CustomEvent(eventName,{detail:{owner,releases}}));
  for(const media of document.querySelectorAll('audio,video'))media.pause();
  return Promise.allSettled(releases).then(()=>{});
}
export function listenAudioFocus(owner,stop){
  const focus=event=>{if(event.detail?.owner!==owner){const release=stop();if(release&&Array.isArray(event.detail?.releases))event.detail.releases.push(release);}},media=event=>{if(event.target?.matches?.('audio,video')&&!event.target.paused)stop();},hidden=()=>{if(document.hidden)stop();};
  window.addEventListener(eventName,focus);document.addEventListener('play',media,true);window.addEventListener('pagehide',stop);window.addEventListener('hashchange',stop);document.addEventListener('visibilitychange',hidden);
  return ()=>{window.removeEventListener(eventName,focus);document.removeEventListener('play',media,true);window.removeEventListener('pagehide',stop);window.removeEventListener('hashchange',stop);document.removeEventListener('visibilitychange',hidden);};
}
