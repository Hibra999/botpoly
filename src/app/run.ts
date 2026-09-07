import 'dotenv/config';
import {main} from './main.js';
main().catch(()=>{
  console.error('Botpoly no pudo arrancar. Revisa Node 24.20.0, Telegram, configuración y evidencia del modo activo.');
  process.exitCode=1;
});
