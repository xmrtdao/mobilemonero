import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Only accept POST requests
    if (req.method !== 'POST') {
      throw new Error('Method not allowed')
    }

    const { room_name, attorney_email, client_email, additional_emails = [] } = await req.json()

    // Validate required fields
    if (!room_name || !attorney_email || !client_email) {
      throw new Error('Room name, attorney email, and client email are required')
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

    // Generate room credentials
    const roomId = 'zero-claw-' + room_name.toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .substring(0, 20) + '-' + Math.random().toString(36).substring(2, 6)
    
    const roomPassword = Math.random().toString(36).substring(2, 8).toUpperCase() + 
                         Math.random().toString(36).substring(2, 4).toUpperCase()

    const participants = [attorney_email, client_email, ...additional_emails]

    // Store room in database
    const { data: roomData, error: insertError } = await supabase
      .from('zero_claw_rooms')
      .insert({
        room_id: roomId,
        room_name: room_name,
        room_password: roomPassword,
        attorney_email: attorney_email,
        client_email: client_email,
        participants: participants,
        created_at: new Date().toISOString(),
        status: 'active'
      })
      .select()
      .single()

    if (insertError) {
      console.error('Database insert error:', insertError)
      throw new Error('Failed to create room in database')
    }

    // Send invitation emails via Resend
    const resendApiKey = Deno.env.get('RESEND_API_KEY') ?? ''
    
    const emailPromises = participants.map(async (email) => {
      const emailResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resendApiKey}`,
        },
        body: JSON.stringify({
          from: 'Zero-Claw <noreply@mobilemonero.com>',
          to: email,
          subject: `Invitation to Zero-Claw Encrypted Chat: ${room_name}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #D4AF37;">🔐 Zero-Claw Encrypted Chat Invitation</h2>
              <p>You've been invited to join a secure, attorney-client privileged chat room.</p>
              
              <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Room Name:</strong> ${room_name}</p>
                <p><strong>Room ID:</strong> <code style="background: #e0e0e0; padding: 2px 6px; border-radius: 4px;">${roomId}</code></p>
                <p><strong>Password:</strong> <code style="background: #e0e0e0; padding: 2px 6px; border-radius: 4px;">${roomPassword}</code></p>
                <p><strong>Access URL:</strong> <a href="https://mobilemonero.com/zero-claw/" style="color: #D4AF37;">https://mobilemonero.com/zero-claw/</a></p>
              </div>
              
              <p style="color: #666; font-size: 14px;">
                <strong>🔒 Security Notice:</strong> This room uses end-to-end encryption with SRP-6a authentication. 
                Messages are encrypted client-side before transmission. The server cannot read message content.
              </p>
              
              <p style="color: #666; font-size: 12px; margin-top: 30px;">
                This is an automated message from Zero-Claw by XMRT DAO. 
                If you did not expect this invitation, please ignore it.
              </p>
            </div>
          `,
        }),
      })

      if (!emailResponse.ok) {
        console.error('Email send failed for', email, await emailResponse.text())
      }
      
      return emailResponse.ok
    })

    const emailResults = await Promise.allSettled(emailPromises)
    const emailsSent = emailResults.filter(r => r.status === 'fulfilled' && r.value).length

    return new Response(
      JSON.stringify({
        success: true,
        room_id: roomId,
        room_password: roomPassword,
        room_url: 'https://mobilemonero.com/zero-claw/',
        participants: participants,
        emails_sent: emailsSent,
        emails_total: participants.length,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    )

  } catch (error) {
    console.error('Error creating room:', error)
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message || 'Failed to create room' 
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      }
    )
  }
})
