import {mnemonicFor,maskTarget} from './mnemonic-data.js';
function element(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
export function renderMnemonic(host,{char,stage,note='',onSave}) {
  host.replaceChildren();host.classList.toggle('hidden',stage===0);
  if(!stage)return;
  const entry=mnemonicFor(char);
  host.append(element('h3','Как запомнить'),element('p','Ассоциация для памяти, не историческое происхождение знака.','source-note'));
  if(note)host.append(element('p','Моя история: '+(stage<3?maskTarget(note,char):note),'mnemonic-story'));
  if(entry)host.append(element('p',(stage<3?maskTarget(entry.story,char):entry.story),'mnemonic-story'));
  if(!entry&&!note)host.append(element('p','Для этого знака пока нет проверенной карточки. Посмотри порядок черт или сохрани свою ассоциацию.'));
  if(stage>=2&&entry){
    if(entry.parts.length){
      const diagram=element('div',undefined,'mnemonic-parts mnemonic-'+entry.layout);
      entry.parts.forEach((part,index)=>{
        const tile=element('div',undefined,'mnemonic-part mnemonic-part-'+index);
        tile.append(element('span',part.position,'mnemonic-position'),element('strong',part.glyph,'mnemonic-glyph'),element('span',part.name));diagram.append(tile);
      });host.append(diagram);
      const source=element('a','Источник структуры: Make Me a Hanzi');source.href='https://github.com/skishore/makemeahanzi';source.target='_blank';source.rel='noopener noreferrer';host.append(source);
    }else host.append(element('p',entry.observation,'mnemonic-observation'));
  }
  if(stage>=3){
    const label=element('label','Моя ассоциация (до 500 символов)');
    const input=element('textarea');input.id='mnemonicNote';input.maxLength=500;input.rows=3;input.value=note;label.htmlFor=input.id;
    const save=element('button','Сохранить мою историю','secondary-button');save.type='button';
    save.onclick=()=>onSave(char,input.value);
    host.append(label,input,save,element('p','Личная история хранится на этом устройстве и в скачанной копии. В подсказке она показывается как написана, кроме самого целевого знака.','source-note'));
  }
}
