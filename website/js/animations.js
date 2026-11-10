document.addEventListener('DOMContentLoaded', () => {
  const revealables = document.querySelectorAll('[data-reveal]');

  // Scroll reveal, adds the class once per element.
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      }
    }, { rootMargin: '0px 0px -100px 0px' });

    for (const el of revealables) {
      const delay = el.getAttribute('data-reveal-delay');
      if (delay) {
        el.style.transitionDelay = `${delay}ms`;
      }
      observer.observe(el);
    }
  } else {
    for (const el of revealables) {
      el.classList.add('revealed');
    }
  }

  // Guide tabs mirror the visible tab into the URL hash.
  // The fragment never reaches the server, so hash links are resolved here on load.
  const tabs = document.querySelectorAll('[data-bs-toggle="tab"]');
  if (tabs.length) {
    const byPlatform = new Map();
    for (const tab of tabs) {
      const platform = tab.dataset.bsTarget.replace('#pane-', '');
      byPlatform.set(platform, tab);
      tab.addEventListener('shown.bs.tab', () => {
        history.replaceState(null, '', `#${platform}`);
      });
    }
    const requested = byPlatform.get(location.hash.slice(1));
    if (requested && !requested.classList.contains('active')) {
      bootstrap.Tab.getOrCreateInstance(requested).show();
    }
  }

  const secretButton = document.getElementById('secretButton');
  if (!secretButton) {
    return;
  }

  const tooltips = [
    'Wanna go down the rabbit hole?',
    'Click to enter the rabbit hole!',
    'Chasing white rabbits?',
    'Follow the white rabbit.',
    'Are you curious yet?',
    'Only one way to find out!',
    'What happens when you click this? Find out!',
    "What's at the end of the tunnel?",
    'A little click can lead to a big adventure!',
    'This is just the beginning.',
    "The rabbit hole doesn't have an exit, only more passages.",
    "The White Rabbit left this just for you.",
    "You're late, aren't you?",
    'Click here to discover something special!',
    'This button holds a secret!',
    'Are you ready for a surprise?',
    'Hovering over this button might reveal a secret!',
    'This button is more than it seems!',
    'Not everything is as it seems...',
    'Shhh... this is a secret.',
    'Unlock the unknown.',
    'Can you keep a secret?',
    'Something strange happens if you click...',
    "You're not curious, are you?",
    'You saw nothing.',
    "This wasn't supposed to be revealed yet.",
    'You found the first step. What now?',
    'Secrets are like shadows, they follow those who look.',
    "You're reading between the lines, aren't you?",
    '404? Not here.',
    'Root access granted.',
    'Access: unauthorized... or is it?',
    'Welcome, Agent.',
    "You've found the backdoor.",
    'Code: 01101110 01101111 01110100.',
    'You are the anomaly.',
    'Compiling curiosity.exe...',
    'Backdoor handshake accepted.',
    'Terminal breach detected.',
    'Connecting to hidden node...',
    'Curiosity is rewarded.',
    'The further you go, the less you understand.',
    "The truth won't reveal itself unless you're ready to seek it.",
    'The more you know, the less you understand.',
    "The truth is a labyrinth. You're not the first to enter.",
    'The deeper you go, the harder it becomes to return.',
    "Once you've seen the unseen, there's no unseeing it.",
    'Once you see the patterns, they never disappear.',
    "The puzzle never has one solution. It's an infinite maze.",
    'You will find what you are looking for, but not in the way you expect.',
    'Truth is recursive. So is this message.',
    'What if this message is reading you?',
    "Don't ask questions you're not prepared to answer.",
    'Are you ready to question everything?',
    'Beyond this lies a story you were not meant to hear.',
    'Lux in tenebris.',
    'Noli tangere nisi praeparatus.',
    'Cave ab homine unius libri.',
    'Tempus fugit.',
    'Ad astra per aspera.',
    'Carpe diem.',
    'Nulla dies sine linea.',
    'Omnia mutantur, nos et mutamur in illis.',
    'Ars est celare artem.',
    'Definitely not a secret.',
    'Just a regular button. Really.',
    'Nothing to see here.',
    'Trust me.',
    "You're getting sleepy...",
    "I wouldn't click that.",
    'Just a friendly suggestion...',
    'This button is harmless... probably.',
    "This is your last chance to turn back.",
    'Big red button energy.',
    'No jumpscares. Probably.',
    'Ignore this tooltip. It is a decoy.',
    'This message will self-destruct.',
    'Warning: Clicking may cause existential dread.',
    "Do not press unless you're ready.",
    "There's absolutely nothing weird here.",
    'This is not reverse psychology.',
    'Oops. Wrong button. Or is it?',
    "You've made it worse. Congrats!",
    'Clicking this breaks the simulation.',
    'This will delete your internet.',
    "Congratulations! You've won absolutely nothing.",
    'This tooltip is sponsored by no one.',
    '99% harmless. 1% mayhem.',
    'Left to right, or right to left? Or maybe both?',
    'Is it turning left or right? Or is that just your perception?',
  ];

  const pick = () => tooltips[Math.floor(Math.random() * tooltips.length)];
  const tooltip = new bootstrap.Tooltip(secretButton, { title: pick() });
  const heart = secretButton.querySelector('.rabbithole');

  let broken = false;

  secretButton.addEventListener('mouseenter', () => {
    if (broken) {
      return;
    }
    tooltip.setContent({ '.tooltip-inner': pick() });
  });

  secretButton.addEventListener('click', () => {
    broken = true;
    heart.textContent = '💔';
    heart.classList.remove('rabbithole');
    document.querySelector('.tooltip')?.remove();
    tooltip.dispose();
  });
});
