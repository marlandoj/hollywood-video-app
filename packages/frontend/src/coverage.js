/** Source text is rendered as DOM text; findings are advisory planning evidence. */
export function showCoverage(container,report,onEdit){
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  container.replaceChildren();if(!report){container.hidden=true;return;}container.hidden=false;
  const total=report.totals;
  const count=(n,label)=>n+" "+label+(n===1?"":"s");
  container.append(node("h3","Coverage review"),node("p",count(total.warnings,"warning")+" · "+count(total.unknowns,"unknown check")+" · "+count(total.notes,"note")),
    node("p","Based on saved shot declarations, not image analysis. Findings are advisory; inspect the preview to verify actual framing and continuity."),
    node("p",count(total.axisComparisons,"declared axis comparison")+" · "+count(total.eyelineComparisons,"reciprocal eyeline comparison")));
  if(!report.scenes.length)container.append(node("p","Save a screenplay with scenes to check coverage."));
  for(const scene of report.scenes){const section=node("details");section.open=report.scenes.length===1;section.append(node("summary","Scene "+(scene.sceneIndex+1)+" · "+scene.findings.length+" findings"));
    const inventory=node("details");inventory.append(node("summary","Declared coverage inventory"));
    for(const [role,ids]of Object.entries(scene.inventory))if(ids.length)inventory.append(node("p",role.replaceAll("-"," ")+": "+ids.join(", ")));
    section.append(inventory);
    if(!scene.findings.length)section.append(node("p","No conflicts were found in the supplied declarations. Undeclared relationships and rendered media are not verified."));
    for(let start=0;start<scene.findings.length;start+=5){const group=scene.findings.length>5?node("details"):section;
      if(group!==section){group.append(node("summary","Findings "+(start+1)+"–"+Math.min(start+5,scene.findings.length)));section.append(group);}
      for(const finding of scene.findings.slice(start,start+5)){const row=node("article");row.className="cast-card";row.append(node("h4",finding.severity.toUpperCase()+" · "+finding.code.replaceAll("-"," ")),node("p",finding.message),node("p","Source shots: "+finding.shotIds.join(", ")));
        if(onEdit&&finding.shotIds.length){const edit=node("button","Review "+finding.shotIds[0]);edit.type="button";edit.className="secondary";edit.onclick=()=>onEdit(finding.shotIds[0]);row.append(edit);}group.append(row);}}
    container.append(section);
  }
}
