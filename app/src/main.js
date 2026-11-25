
import './style.css'

const app = document.querySelector('#app')

app.innerHTML = `
  <main class="container">
    <header>
      <div class="logo">D<span>P</span></div>
      <div>
        <h1>DeelishPay</h1>
        <p>YOUR PRIVATE PAYMENT AGENT</p>
      </div>
      <span class="status">● Connected</span>
    </header>

    <section class="wallet">
      <p>AGENT WALLET BALANCE</p>
      <h2 id="balance">Checking...</h2>
      <span>Gloam · Robinhood Chain</span>
    </section>

    <section class="chat">
      <h3>Chat with DeelishPay</h3>

      <div id="messages">
        <div class="bubble agent">
          Hey! I'm DeelishPay 👋<br><br>
          I can help you make private USDG payments.
          <br>What would you like me to do?
        </div>
      </div>

      <form id="chat-form">
        <input
          id="message"
          placeholder="E.g. Send 0.1 USDG to my wallet..."
          autocomplete="off"
          required
        />
        <button type="submit">Send</button>
      </form>
    </section>

    <p class="notice">
      Payments require your confirmation before execution.
    </p>
  </main>
`

const form = document.querySelector('#chat-form')
const input = document.querySelector('#message')
const messages = document.querySelector('#messages')

async function readResponse(response) {
  const raw = await response.text()

  let data

  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(
      `Server response error (${response.status}): ${
        raw.slice(0, 200) || 'Empty response'
      }`
    )
  }

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`)
  }

  return data
}

function addMessage(text, type = 'agent') {
  const bubble = document.createElement('div')
  bubble.className = `bubble ${type}`
  bubble.textContent = text
  messages.appendChild(bubble)
  messages.scrollTop = messages.scrollHeight
  return bubble
}

function addReview(amount, reviewId) {
  const card = document.createElement('div')
  card.className = 'bubble agent review-card'

  const heading = document.createElement('strong')
  heading.textContent = 'Payment review'

  const details = document.createElement('p')
  details.textContent =
    `Amount: ${amount} USDG\nRecipient: Your personal Gloam wallet\nType: Private transfer`

  const confirm = document.createElement('button')
  confirm.textContent = 'Confirm payment'
  confirm.type = 'button'

  const cancel = document.createElement('button')
  cancel.textContent = 'Cancel'
  cancel.type = 'button'
  cancel.className = 'cancel-button'

  card.append(heading, details, confirm, cancel)
  messages.appendChild(card)

  cancel.onclick = () => {
    card.remove()
    addMessage('Payment review cancelled.')
  }

  confirm.onclick = async () => {
    confirm.disabled = true
    cancel.disabled = true
    confirm.textContent = 'Processing...'

    try {
      const response = await fetch('/api/payment/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewId })
      })

      const result = await readResponse(response)

      card.remove()

      addMessage(
        `Payment submitted. Transaction: ${result.txHash}`
      )
    } catch (error) {
      confirm.textContent = 'Confirmation needs checking'
      addMessage(error.message)
      addMessage(
        'Please check the payment status before attempting another transaction.'
      )
    }
  }

  messages.appendChild(document.createElement('div'))
  messages.scrollTop = messages.scrollHeight
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()

  const message = input.value.trim()
  if (!message) return

  addMessage(message, 'user')
  input.value = ''

  const match = message.match(
    /send\s+(\d+(?:\.\d+)?)\s+usdg/i
  )

  if (!match) {
    addMessage('Try something like: Send 0.1 USDG to my wallet.')
    return
  }

  const amount = Number(match[1])

  if (!Number.isFinite(amount) || amount <= 0) {
    addMessage('Please enter a valid payment amount.')
    return
  }

  addMessage('Preparing your private payment...')

  try {
    const response = await fetch('/api/payment/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    })

    const result = await readResponse(response)

    addReview(amount, result.reviewId)

  } catch (error) {
    addMessage(error.message)
  }
})
