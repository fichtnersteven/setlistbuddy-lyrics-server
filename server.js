
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use("/lyrics",
  rateLimit({
    windowMs: 60 * 1000,
    max: 30,
  })
);

const CACHE_TTL = 1000 * 60 * 60;
const cache = new Map();

function cacheKey(title, artist) {
  return `${(title||"").toLowerCase()}::${(artist||"").toLowerCase()}`;
}

function cacheGet(title, artist) {
  const k = cacheKey(title, artist);
  const entry = cache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(k);
    return null;
  }
  return entry.data;
}

function cacheSet(title, artist, data) {
  cache.set(cacheKey(title, artist), { data, timestamp: Date.now() });
}

const http = axios.create({
  timeout: 12000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  },
});

async function fetchRetry(url, tries = 3) {
  for (let i=0;i<tries;i++){
    try { return await http.get(url); }
    catch(e){
      if(i===tries-1) throw e;
      await new Promise(r=>setTimeout(r,300+i*300));
    }
  }
}

async function geniusSearch(query) {
  const key = process.env.GENIUS_API_KEY;
  if (!key) return null;
  try {
    const resp = await axios.get("https://api.genius.com/search", {
      params:{ q:query },
      headers:{ Authorization:"Bearer "+key },
      timeout:8000
    });
    const hit = resp?.data?.response?.hits?.[0]?.result;
    if(!hit) return null;
    return {
      title: hit.title,
      artist: hit.primary_artist?.name,
      url: hit.url
    };
  } catch(e){
    return null;
  }
}

function normalize(s){
  return (s||"").toLowerCase().normalize("NFKD").replace(/[^\w\s]/g,"").trim();
}

function fuzzy(a,b){
  a=normalize(a); b=normalize(b);
  if(!a||!b) return false;
  return a.includes(b)||b.includes(a);
}

function songtexteSearchUrl(q){
  return "https://www.songtexte.com/suche?c=all&q="+encodeURIComponent(q);
}

function parseTopHit($){
  const hit=$(".topHitBox .topHit");
  if(!hit.length) return null;
  const href=hit.find(".topHitLink").attr("href");
  const title=hit.find(".topHitLink").text().trim();
  const artist=hit.find(".topHitSubline a").text().trim();
  if(!href||!title||!artist) return null;
  return { href, title:title.toLowerCase(), artist:artist.toLowerCase() };
}

function parseListHits($){
  const results=[];
  $(".songResultTable > div > div").each((i,row)=>{
    const $r=$(row);
    const link=$r.find(".song a[href*='/songtext/']").first();
    const href=link.attr("href");
    const t=link.text().trim();
    const a=$r.find(".artist span").last().text().trim();
    if(href&&t&&a) results.push({ href, title:t.toLowerCase(), artist:a.toLowerCase() });
  });
  return results;
}

async function findBestMatch(t,a){
  const searchRes=await fetchRetry(songtexteSearchUrl(t+" "+a));
  const $=cheerio.load(searchRes.data);

  const nt=normalize(t), na=normalize(a);
  const top=parseTopHit($);
  const list=parseListHits($);

  if(top && fuzzy(top.title,nt) && fuzzy(top.artist,na)) return top;
  for(const r of list) if(fuzzy(r.title,nt)&&fuzzy(r.artist,na)) return r;
  for(const r of list) if(fuzzy(r.title,nt)) return r;
  if(top) return top;
  return list[0]||null;
}

function cleanLyrics(txt){
  if(!txt) return "";
  return txt
    .replace(/<!--([\s\S]*?)-->/g,"")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"")
    .replace(/ADNPM\.[^\n]+/g,"")
    .replace(/\*\/+/g,"")       # remove stray */
    .replace(/<[^>]*>/g,"")
    .replace(/\r/g,"")
    .replace(/[ \t]+$/gm,"")
    .replace(/\n{3,}/g,"\n\n")
    .trim();
}

async function extractLyrics(href){
  const clean=href.startsWith("/")?href:"/"+href;
  const url="https://www.songtexte.com"+clean;
  const res=await fetchRetry(url);
  const $=cheerio.load(res.data);
  const raw=$("#lyrics").text().trim()||$(".lyrics").text().trim()||$(".songtext").text().trim()||"";
  return { url, lyrics: cleanLyrics(raw) };
}

function similarity(a,b){
  a=(a||"").toLowerCase(); b=(b||"").toLowerCase();
  const len=Math.min(a.length,b.length);
  if(!len) return 0;
  let m=0;
  for(let i=0;i<len;i++) if(a[i]===b[i]) m++;
  return m/len;
}

function detectStructure(text){
  const blocks=text.split(/\n\s*\n/).map(b=>b.trim()).filter(b=>b.length>0);
  if(!blocks.length) return [];
  const norm=blocks.map(b=>b.toLowerCase());

  let chorusIndex=-1;
  for(let i=0;i<norm.length;i++){
    for(let j=i+1;j<norm.length;j++){
      if(similarity(norm[i],norm[j])>0.55){ chorusIndex=i; break; }
    }
    if(chorusIndex!==-1) break;
  }

  const sections=[];
  blocks.forEach((block,idx)=>{
    let type="verse";
    let conf=0.5;

    if(idx===chorusIndex && chorusIndex!==-1){ type="chorus"; conf=0.9; }
    else if(idx>chorusIndex && chorusIndex!==-1){
      if(similarity(norm[idx],norm[chorusIndex])>0.55){ type="chorus"; conf=0.85; }
    }

    if(type==="verse" && idx>1 && idx>=blocks.length-2){
      type="bridge"; conf=Math.max(conf,0.6);
    }

    sections.push({ type, confidence:conf, text:block });
  });

  return sections;
}

app.get("/lyrics", async (req,res)=>{
  const title=(req.query.title||"").trim();
  const artist=(req.query.artist||"").trim();
  if(!title) return res.status(400).json({ success:false, error:"title fehlt" });

  const cached=cacheGet(title,artist);
  if(cached) return res.json({...cached, cache:true});

  let finalTitle=title, finalArtist=artist, geniusUrl=null;

  const genius=await geniusSearch(`${title} ${artist}`);
  if(genius){
    finalTitle=genius.title||finalTitle;
    finalArtist=genius.artist||finalArtist;
    geniusUrl=genius.url||null;
  }

  try{
    const match=await findBestMatch(finalTitle,finalArtist);
    if(!match) return res.json({success:false,error:"Kein Treffer"});

    const lr=await extractLyrics(match.href);
    if(!lr.lyrics) return res.json({success:false,error:"Keine Lyrics"});

    const sections=detectStructure(lr.lyrics);

    const resp={
      success:true,
      title:finalTitle,
      artist:finalArtist,
      lyrics:lr.lyrics,
      lyricsUrl:lr.url,
      geniusUrl,
      sections,
      cache:false
    };

    cacheSet(title,artist,resp);
    res.json(resp);
  }catch(e){
    res.json({success:false,error:"Serverfehler"});
  }
});

app.get("/",(req,res)=>{
  res.json({status:"ok",service:"lyrics-server",time:new Date().toISOString()});
});

app.listen(PORT,()=>console.log("Server läuft auf Port",PORT));
