export class EditConflict extends Error {override name="EditConflict";}
export function editFail(message:string):never{throw new EditConflict(message);}
export function editNumber(value:unknown,min:number,max:number,label:string,integer=true):number{if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max||integer&&!Number.isSafeInteger(value))editFail(label+" is outside its supported range.");return value;}
