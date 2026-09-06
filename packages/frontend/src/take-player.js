/** One media clock drives the comparison; buffering pauses the whole group. */
export function takePlayer({parent,clips,assetUrl,selected,select}) {
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const button=(label,action)=>{const e=node("button",label);e.type="button";e.className="secondary";e.onclick=action;return e;};
  const root=node("div"),tabs=node("div"),grid=node("div"),controls=node("div"),status=node("p"),time=node("output"),seek=node("input"),audio=node("input");
  root.className="take-player";grid.className="take-grid";tabs.className=controls.className="result-actions";status.setAttribute("role","status");seek.type="range";seek.min="0";seek.step=String(1/30);seek.value="0";seek.setAttribute("aria-label","Comparison time in seconds");
  const duration=Math.max(...clips.map(c=>c.durationSec)),master=clips.findIndex(c=>c.durationSec===duration),videos=[],cards=[],choices=[];seek.max=String(duration);
  let chosen=Math.max(0,clips.findIndex(c=>c.id===selected)),position=0,wanted=false,starting=false,disposed=false,frame,epoch=0;
  const endAt=i=>Math.max(0,clips[i].durationSec-1/30),finished=i=>i===master?position>=duration:position>=endAt(i)-1/30||videos[i]?.ended,ready=()=>videos.every((v,i)=>v.readyState>=3||finished(i));
  const applySelection=()=>{videos.forEach((v,i)=>{v.muted=!audio.checked||i!==chosen;cards[i].dataset.selected=String(i===chosen);choices[i].setAttribute("aria-pressed",String(i===chosen));});select(clips[chosen].id);};
  clips.forEach((clip,i)=>{
    const card=node("article"),video=node("video"),choice=button(clip.label,()=>{chosen=i;applySelection();});card.className="take-card";video.preload="auto";video.playsInline=true;video.muted=true;video.src=assetUrl(clip.mp4Url);video.poster=assetUrl(clip.posterUrl);video.setAttribute("aria-label",clip.label+" video");
    const track=node("track");track.kind="captions";track.label="Captions";track.srclang="en";track.src=assetUrl(clip.captionsUrl);video.append(track);
    const mode={synthetic:"Synthetic test media",storyboard:"Supplied-image storyboard; no generated subject motion",preview:"Storyboard preview",video:"Generated video"}[clip.mode]??clip.mode;
    const caption=node("p",mode+" · "+clip.durationSec.toFixed(2)+" s · seed "+clip.seed+" · $"+clip.costUsd.toFixed(3));caption.className="environment";
    const links=node("details");links.append(node("summary","Download "+clip.label));const actions=node("div");actions.className="result-actions";
    for(const [label,path]of [["MP4",clip.mp4Url],["Captions",clip.captionsUrl],["Provenance",clip.manifestUrl]]){const a=node("a",label);a.href=assetUrl(path);a.download="";actions.append(a);}links.append(actions);
    card.append(node("h4",clip.label),video,caption,links);videos.push(video);cards.push(card);choices.push(choice);grid.append(card);tabs.append(choice);
    video.addEventListener("waiting",()=>{if(wanted&&!finished(i)){videos.forEach(v=>v.pause());status.textContent="Buffering all takes…";}});
    video.addEventListener("error",()=>{pause();status.textContent="A take could not load. Refresh the groups to renew its private media link.";});
  });
  const play=button("Play all takes",()=>{if(wanted){pause();return;}if(position>=duration)move(0);wanted=true;play.textContent="Pause all takes";status.textContent="Starting comparison…";resume();});
  function pause(){wanted=false;epoch++;videos.forEach(v=>v.pause());play.textContent="Play all takes";}
  function move(value){pause();position=Math.min(duration,Math.max(0,value));videos.forEach((v,i)=>{if(v.readyState>0)v.currentTime=Math.min(position,endAt(i));});display();}
  function display(){seek.value=String(position);time.textContent=position.toFixed(2)+" / "+duration.toFixed(2)+" s · frame "+Math.round(position*30);}
  async function resume(){if(starting||disposed||!wanted||!ready())return;starting=true;const version=epoch;
    try{await Promise.all(videos.map((v,i)=>finished(i)||!v.paused?Promise.resolve():v.play()));if(disposed||!wanted||version!==epoch){videos.forEach(v=>v.pause());return;}status.textContent="Playing together. Shorter takes hold their last frame.";}
    catch(error){if(!disposed&&wanted&&version===epoch&&error.name!=="AbortError"){pause();status.textContent="Playback could not start. Wait for the videos to load, then press Play all takes.";}}
    finally{starting=false;}
  }
  function tick(){if(disposed)return;play.disabled=videos.some(v=>v.readyState===0);
    if(wanted){const clock=videos[master];if(!clock.paused)position=Math.min(duration,clock.currentTime);
      if(clock.ended||position>=duration){position=duration;pause();status.textContent="Comparison complete. Choose a take to adopt its settings.";}
      else if(!ready()){videos.forEach(v=>v.pause());status.textContent="Buffering all takes…";}
      else {videos.forEach((v,i)=>{if(finished(i)){v.pause();if(Math.abs(v.currentTime-endAt(i))>1/60)v.currentTime=endAt(i);}else if(i!==master&&Math.abs(v.currentTime-position)>1/30)v.currentTime=position;});if(videos.some((v,i)=>!finished(i)&&v.paused))resume();}display();
    }frame=requestAnimationFrame(tick);
  }
  seek.addEventListener("input",()=>{move(Number(seek.value));status.textContent="Paused at the selected comparison time.";});
  audio.type="checkbox";audio.addEventListener("change",applySelection);const audioLabel=node("label","Hear selected take only");audioLabel.className="attestation";audioLabel.prepend(audio);
  controls.append(play,button("Previous frame",()=>move(position-1/30)),button("Next frame",()=>move(position+1/30)),audioLabel);
  root.append(node("p","Playback starts at the same time for every take. Shorter takes hold their last frame. Audio comes only from the selected take when enabled."),tabs,grid,controls,seek,time,status);parent.append(root);applySelection();display();tick();
  return {pause,destroy(){disposed=true;pause();cancelAnimationFrame(frame);videos.forEach(v=>{v.removeAttribute("src");v.load();});root.remove();}};
}
