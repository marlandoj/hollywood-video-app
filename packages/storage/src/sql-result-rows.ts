import {types} from "node:util";

/** Normalize only the trusted query-result container. Bun SQLResultArray is an
 * Array subclass; its prototype and command/count fields are transport metadata.
 * Domain row bodies still require the caller's complete portable/schema checks. */
export function sqlResultRows(value:unknown,limit:number,message:string):unknown[]{
  const fail=():never=>{throw new Error(message);};
  if(!Number.isSafeInteger(limit)||limit<0||types.isProxy(value)||!Array.isArray(value))fail();
  const length=Object.getOwnPropertyDescriptor(value,"length"),count=length?.value;
  if(!length||!Object.hasOwn(length,"value")||!Number.isSafeInteger(count)||count<0||count>limit)fail();
  const rows:unknown[]=[];
  for(let index=0;index<count;index++){
    const field=Object.getOwnPropertyDescriptor(value,String(index));
    if(!field||!field.enumerable||!Object.hasOwn(field,"value"))fail();
    rows.push(field!.value);
  }
  return rows;
}
