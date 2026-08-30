/*
 * Homepage "ask the human" mini-form — the visible counterpart of the
 * message_human_operator WebMCP tool, and its declarative twin (the
 * toolname/tooldescription attributes live on the form element).
 * Posts to the same endpoint as the tool and the /contact form.
 */
(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('home-ask-form');
    if (!form) return;
    var result = document.getElementById('home-ask-result');

    function show(text, ok) {
      result.hidden = false;
      result.textContent = text;
      result.style.color = ok ? 'var(--ok)' : 'var(--bad)';
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var message = (document.getElementById('home-ask-message').value || '').trim();
      var replyTo = (document.getElementById('home-ask-reply').value || '').trim();
      if (message.length < 5 || !replyTo) {
        show('A message (5+ characters) and a reply-to email are required.', false);
        return;
      }
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      fetch('/api/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message, reply_to: replyTo, subject: 'From the homepage', source: 'web' }),
      }).then(function (res) {
        return res.json().then(function (data) {
          if (res.ok && data.message_id) {
            form.reset();
            show('Received (' + data.message_id + '). A real human replies within 12 hours — usually much faster.', true);
          } else {
            show(data.message || (data.details && data.details.join(' ')) || 'That didn’t go through — try the contact page.', false);
          }
        });
      }).catch(function () {
        show('Network hiccup — try again or use the contact page.', false);
      }).then(function () {
        btn.disabled = false;
      });
    });
  });
})();
