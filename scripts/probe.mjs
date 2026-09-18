process.loadEnvFile('.env');
const response=await fetch('https://openrouter.ai/api/alpha/decisions',{
  method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),
  headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json'},
  body:JSON.stringify({model:'typesafe/jev-1.13',state:{page:'A page has a Search button and a Cancel button.',goal:'Start the search.'},questions:{decision:{type:'choice',instructions:'Choose the action that advances the goal.',criteria:{search:'Click Search',cancel:'Click Cancel'}}}})
});
const result=await response.json();
if(!response.ok){console.log(JSON.stringify({status:response.status,error:result.error?.message}));process.exitCode=1;}
else console.log(JSON.stringify({status:response.status,model:result.model,answer:result.answers?.decision,usage:result.usage},null,2));
