/** Bun 1.4.0 SQLResultArray has an Array subclass prototype and nonenumerable
 * transport fields. This models that container only, never SQL execution/locks. */
export class SQLResultFixture<T> extends Array<T>{
  static get [Symbol.species](){return Array;}
  constructor(rows:readonly T[]){
    super();for(const row of rows)this.push(row);
    Object.defineProperties(this,{count:{value:rows.length,writable:true},command:{value:"SELECT",writable:true},lastInsertRowid:{value:null,writable:true},affectedRows:{value:null,writable:true}});
  }
}
