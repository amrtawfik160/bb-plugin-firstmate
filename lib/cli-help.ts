import {z} from 'zod';
/** The CLI registration and general help share the tool's actual option schema. */
export function optionHelp(schema:z.ZodObject, aliases:Record<string,string>, omit:string[]=[]) {
  const json=z.toJSONSchema(schema) as {properties?:Record<string,{type?:string;enum?:unknown[];description?:string;not?:unknown}>};
  return Object.entries(json.properties??{}).filter(([name])=>!omit.includes(name)).map(([name,p])=>{
    const flag=aliases[name]??name.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());
    const value=p.enum ? ' <'+p.enum.join('|')+'>' : p.type==='boolean' ? '' : p.not ? ' (unsupported)' : ' <value>';
    return `  --${flag}${value}${name==='visible' && flag==='hidden' ? '  Hide crew in the sidebar (default visible)' : p.description ? '  '+p.description : ''}`;
  }).join('\n');
}
