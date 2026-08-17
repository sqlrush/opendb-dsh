#!/usr/bin/env bash
set -u
P=$(kubectl -n opendb-dsh get pod -l app=host -o 'jsonpath={.items[0].metadata.name}')
for hh in "127.0.0.1:3080" "192.168.139.164:30080" "10.42.0.10:3080" "example.invalid:9"; do
  printf "%-24s " "$hh"
  kubectl -n opendb-dsh exec "$P" -- node -e "
const http=require('node:http');
const body=JSON.stringify({type:'client-request',rpcId:'t',method:'session.create',payload:{}});
const req=http.request({host:'127.0.0.1',port:3080,path:'/api/session.create',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),host:'$hh'}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(res.statusCode, d.slice(0,60)))});
req.end(body);" 2>&1 | tail -1
done
