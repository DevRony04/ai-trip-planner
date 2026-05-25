import { NextRequest, NextResponse } from "next/server";
import OpenAI from 'openai';
import { aj } from "@/lib/arcjet";
import { currentUser } from "@clerk/nextjs/server";
import { auth } from '@clerk/nextjs/server'
const PROMPT = `You are an AI Trip Planner Agent. Help the user plan a trip by asking EXACTLY one relevant question at a time and progressing only to the NEXT missing field.

Required fields (ask strictly in this order):
1) Hey traveler! Where are you starting your journey from? ✈️
2) And where would you like to go? 🏝️
3) Group size (Solo, Couple, Family, Friends)
4) Budget (Low, Medium, High)
5) Trip duration (number of days)
6) Travel interests (e.g., adventure, sightseeing, cultural, food, nightlife, relaxation)
7) Special requirements or preferences (if any)

Notes:
- Ask for trip duration at step 5 and proceed to the next missing field after it's provided.

Behavioral rules:
- Keep track of which fields are ALREADY answered in the conversation. Do NOT repeat questions already answered unless the user explicitly changes their answer.
- Never ask the same field twice in a row.
- If the user’s message includes information for multiple fields, extract them and mark those fields as answered, then ask only for the next missing field.
- Ask exactly ONE concise question per turn, and avoid filler or repetition.
- If any answer is unclear or incomplete, ask a brief clarification for that specific field only.
- When all required information is collected, set ui to 'final' and stop asking more questions.

Generative UI control:
- Set ui ONLY when your question is specifically about that UI field: 'budget' when asking Budget, 'groupSize' when asking Group size, 'tripDuration' when asking Trip duration. For all other steps (origin, destination, interests, special requirements), OMIT ui (leave it empty/undefined). When all fields are collected, set ui to 'final'.

Response templates (STRICTLY follow these):
- When asking Group size:
  {
    resp: "Who are you traveling with? (Solo, Couple, Family, Friends)",
    ui: "groupSize"
  }
- When asking Budget:
  {
    resp: "What's your budget? (Low, Medium, High)",
    ui: "budget"
  }
- When asking Trip duration:
  {
    resp: "How many days will you be traveling?",
    ui: "tripDuration"
  }
- When asking Interests:
  {
    resp: "What are your interests for this trip (e.g., adventure, sightseeing, cultural, food, nightlife, relaxation)?",
    ui: ""
  }
- When asking Origin/Destination/Special requirements:
  {
    resp: "<your single concise question>",
    ui: ""
  }
- When everything is collected:
  {
    resp: "Great, generating your plan now...",
    ui: "final"
  }

Output:
Return ONLY a strict JSON object (no extra text). Schema:
{
  resp: 'Text Resp',
  ui: 'budget/groupSize/tripDuration/final'
}
  `

const FINAL_PROMPT = `Generate Travel Plan with give details, give me Hotels options list with HotelName,
 Hotel address, Price, hotel image url, geo coordinates, rating, descriptions and suggest itinerary with placeName, Place Details, Place Image Url,
  Geo Coordinates, Place address, ticket Pricing, Time travel each of the location, with each day plan with best time to visit in JSON format.
Output Schema:
{
  "trip_plan": {
    "destination": "string",
    "duration": "string",
    "origin": "string",
    "budget": "string",
    "group_size": "string",
    "hotels": [
      {
        "hotel_name": "string",
        "hotel_address": "string",
        "price_per_night": "string",
        "hotel_image_url": "string",
        "geo_coordinates": {
          "latitude": "number",
          "longitude": "number"
        },
        "rating": "number",
        "description": "string"
      }
    ],
    "itinerary": [
      {
        "day": "number",
        "day_plan": "string",
        "best_time_to_visit_day": "string",
        "activities": [
          {
            "place_name": "string",
            "place_details": "string",
            "place_image_url": "string",
            "geo_coordinates": {
              "latitude": "number",
              "longitude": "number"
            },
            "place_address": "string",
            "ticket_pricing": "string",
            "time_travel_each_location": "string",
            "best_time_to_visit": "string"
          }
        ]
      }
    ]
  }
}
  `
  export async function POST(req: NextRequest) {
    const { messages, isFinal } = await req.json();
    const user = await currentUser();
    const {has} =await auth();
    const hasPremiumAccess = has({ plan: 'monthly' })
    console.log("hasPremiumAccess", hasPremiumAccess);
    const decision = await aj.protect(req, { userId:user?.primaryEmailAddress?.emailAddress??'', requested: isFinal? 5 : 0 }); // Deduct 5 tokens from the bucket

    // Show limit message if Arcjet denies and user is not premium
    //@ts-ignore
    if (decision?.reason?.remaining==0 && !hasPremiumAccess) {
      return NextResponse.json({
        resp: "No Free Credit Remaining",
        ui: "limit"
      })
    }
    
  
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return NextResponse.json({ error: "Missing GEMINI_API_KEY" }, { status: 500 });
      }
  
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;
  
      const history = (messages || []).map((m: { role: string; content: string }) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content || '' }],
      }));
  
      const body = {
        system_instruction: {
          parts: [{ text: isFinal ? FINAL_PROMPT : PROMPT }],
        },
        contents: history,
        generationConfig: {
          response_mime_type: "application/json",
        },
      };
  
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
  
      if (!res.ok) {
        const errText = await res.text();
        return NextResponse.json({ error: errText || 'Gemini request failed' }, { status: res.status });
      }
  
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = JSON.parse(text || '{}');
      return NextResponse.json(parsed);
    }
    catch (e) {
      return NextResponse.json({ error: (e as Error)?.message || 'Unknown error' }, { status: 500 });
    }
  }