/* Live demo: one block, seven sentences, through the miniloop. */
const SENTENCES = [
  {id:"b0007_s0000", zh:"御坂美琴推开咖啡店的门，环顾四周。", en:"Misaka Mikoto pushes open the café door and looks around."},
  {id:"b0007_s0001", zh:"「姐姐大人，您迟到了十分钟。」", en:"“Onee-sama, you're ten minutes late.”", dialogue:true},
  {id:"b0007_s0002", zh:"白井黑子坐在窗边，晃了晃手中的杯子。", en:"Shirai Kuroko sits by the window, swirling her cup."},
  {id:"b0007_s0003", zh:"「初春说她马上就到。」", en:"“Uiharu says she'll be here any moment.”", dialogue:true},
  {id:"b0007_s0004", zh:"话音未落，初春饰利推门进来。", en:"Just then, Uiharu Kazari comes through the door.", boundaryBefore:true},
  {id:"b0007_s0005", zh:"「抱歉，我来晚了！」", en:"“Sorry I'm late!”", dialogue:true},
  {id:"b0007_s0006", zh:"美琴想起黑子早上提到的风纪委员巡逻。", en:"Mikoto recalls the Judgement patrol Kuroko mentioned that morning."},
];
const sentrow = document.getElementById('sentrow');
SENTENCES.forEach(s=>{
  const d=document.createElement('div'); d.className='sent'; d.id='el_'+s.id;
  d.innerHTML = `<span class="sid">${s.id}</span>${s.zh}<span class="gloss">${s.en}</span>
    <span class="tag speaker"></span><span class="tag present">PRESENT</span><span class="tag mentioned">MENTIONED</span>`;
  sentrow.appendChild(d);
});
const $=id=>document.getElementById(id);
const dots=$('dots'); for(let i=0;i<7;i++){const d=document.createElement('i');dots.appendChild(d);}
function mark(sid, word, cls){
  const el=$('el_'+sid); if(!el) return;
  el.childNodes.forEach(n=>{ if(n.nodeType===3 && n.textContent.includes(word)){
    const parts=n.textContent.split(word);
    const span=document.createElement('span');
    span.innerHTML=parts[0]+`<mark class="${cls}">${word}</mark>`+parts.slice(1).join(word);
    el.replaceChild(span,n);
  }});
}
function chip(text, cls){return `<span class="chip ${cls||""}">${text}</span>`;}

const STEPS=[
 {t:1900, cap:["Step 1 — Sectioning (code, no model)","The block is auto-segregated into sentences. Stable IDs + offsets become the provenance anchor for everything downstream."],
  run(){ SENTENCES.forEach(s=>$('el_'+s.id).classList.add('on')); }},
 {t:2100, cap:["Step 2 — Scene Boundary patch · noul","A noul question per sentence: does a new scene begin here? At s0004 the answer is 0.91 — someone enters, the scene's cast changes."],
  run(){ $('el_b0007_s0004').classList.add('boundary'); }},
 {t:2300, cap:["Step 3 — Dialogue Detector patch · choice","Which sentences are dialogue? segment_kind classifies each one, and continues_previous_dialogue stitches multi-sentence turns into dialogue units."],
  run(){ SENTENCES.filter(s=>s.dialogue).forEach(s=>$('el_'+s.id).classList.add('dialogue'));
         $('el_b0007_s0001').classList.add('stitched'); }},
 {t:2600, cap:["Step 4 — Name Detector patch · code scan first, then Jev","Known names/aliases are matched by exact code scan — free and certain. The unknown candidate 初春饰利 goes to Jev: is_new_name → 0.93."],
  run(){ mark('b0007_s0000','御坂美琴','known'); mark('b0007_s0006','黑子','known');
         mark('b0007_s0004','初春饰利','newname');
         $('colProps').innerHTML += chip('＋ new Character: 初春饰利 (0.93)','new');
         setCs(1); }},
 {t:2400, cap:["Step 5 — Presence Detector patch · one noul per candidate","Present ≠ mentioned. Mikoto and Kuroko are in the room; Uiharu joins at s0004. In s0006 the patrol — and Kuroko's morning remark — are only talked about."],
  run(){ $('splitcols').style.display='flex'; $('splitcols').classList.add('show');
         $('colPresent').innerHTML = chip('御坂美琴 Mikoto')+chip('白井黑子 Kuroko')+chip('初春饰利 Uiharu','new');
         $('colMentioned').innerHTML = chip('风纪委员 patrol (a thing, not a person)');
         ['b0007_s0000','b0007_s0002'].forEach(id=>{const t=$('el_'+id).querySelector('.tag.present'); t.classList.add('show');});
         setCs(2); }},
 {t:2400, cap:["Step 6 — Speaker Attribution patch · choice","One pick per dialogue unit, from characters present + narrator + unknown. Speech style and turn alternation do the heavy lifting."],
  run(){ const map={'b0007_s0001':'🗣 白井黑子 Kuroko','b0007_s0003':'🗣 白井黑子 Kuroko','b0007_s0005':'🗣 初春饰利 Uiharu'};
         Object.entries(map).forEach(([id,who])=>{const t=$('el_'+id).querySelector('.tag.speaker'); t.textContent=who; t.classList.add('show');});
         $('colProps').innerHTML += chip('＋ 3 SPEAKS_TO turns')+chip('＋ Scene ×1 · PRESENT_IN ×3');
         setCs(5); }},
 {t:2600, cap:["Step 7 — Accumulate, don't write","The block's proposals sit in its ChangeSet. The main graph is untouched until the main agent reviews at the merge gate. Then the next block rolls."],
  run(){ $('csbar').classList.add('show'); $('csfill').style.width='100%'; }},
];
function setCs(n){ $('cscount').textContent = n+' proposal'+(n===1?'':'s'); $('csfill').style.width=(n/5*100)+'%'; }

let stepIdx=0, timer=null;
function reset(){
  SENTENCES.forEach(s=>{const el=$('el_'+s.id); el.className='sent';});
  document.querySelectorAll('.tag').forEach(t=>t.classList.remove('show'));
  $('splitcols').classList.remove('show'); $('splitcols').style.display='';
  $('colPresent').innerHTML=''; $('colMentioned').innerHTML=''; $('colProps').innerHTML='';
  $('csbar').classList.remove('show'); setCs(0);
  [...dots.children].forEach(d=>d.classList.remove('done'));
}
function play(){
  clearTimeout(timer); reset(); stepIdx=0;
  const next=()=>{
    if(stepIdx>=STEPS.length){ timer=setTimeout(play, 4200); return; }
    const st=STEPS[stepIdx];
    $('caption').innerHTML=`<span class="stepno">${stepIdx+1} / ${STEPS.length}</span>${st.cap[0]}<span class="why">${st.cap[1]}</span>`;
    st.run(); dots.children[stepIdx].classList.add('done'); stepIdx++;
    timer=setTimeout(next, st.t);
  };
  next();
}
$('replay').onclick=play; play();
