export class EditConflict extends Error {override name="EditConflict";}
export function editFail(message:string):never{throw new EditConflict(message);}
/**
 * HV-025-14: an editorial job that ran out of its time or memory. It is not retried: the same cut takes
 * the same time and memory again, and each retry restarted from nothing (G24 ran past three hours).
 */
export class EditResourceLimit extends EditConflict {override name="EditResourceLimit";}
export function editNumber(value:unknown,min:number,max:number,label:string,integer=true):number{if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max||integer&&!Number.isSafeInteger(value))editFail(label+" is outside its supported range.");return value;}
