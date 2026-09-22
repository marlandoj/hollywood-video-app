/**
 * Named public figures the prompt gate refuses (G12-202609191900).
 *
 * The operator's policy: real people appear in a film only through a consented cast
 * record (`kind: "consented-real-person"`, docs/CASTING.md). Nobody can attest consent
 * for a public figure from an anonymous studio, so naming one is refused outright,
 * whatever the cast says.
 *
 * This is a keyword list, not a likeness detector. It covers widely known living people
 * and recently deceased people whose likeness is commercially managed. Historical
 * figures are not listed. It is matched case-insensitively and accent-insensitively,
 * with spaces, hyphens and dots interchangeable, and only on whole words, so "Taylor
 * walks swiftly" passes. Growing it is always allowed; removing a name is a
 * safety-refusal shrink and needs a human gate (CLAUDE.md).
 *
 * Mononyms are listed only where the word has no everyday meaning ("Beyoncé" yes,
 * "Madonna", "Prince", "Drake" and "Adele" no).
 */
export const PUBLIC_FIGURES: readonly string[] = [
  // Heads of state and government, and senior politicians
  "Donald Trump", "Melania Trump", "Joe Biden", "Kamala Harris", "Barack Obama", "Michelle Obama", "Hillary Clinton",
  "Bill Clinton", "George W. Bush", "JD Vance", "Nancy Pelosi", "Alexandria Ocasio-Cortez", "Bernie Sanders",
  "Vladimir Putin", "Volodymyr Zelensky", "Volodymyr Zelenskyy", "Xi Jinping", "Kim Jong Un", "Narendra Modi",
  "Emmanuel Macron", "Keir Starmer", "Rishi Sunak", "Boris Johnson", "Justin Trudeau", "Mark Carney", "Olaf Scholz",
  "Friedrich Merz", "Angela Merkel", "Giorgia Meloni", "Benjamin Netanyahu", "Recep Tayyip Erdogan", "Javier Milei",
  "Lula da Silva", "Claudia Sheinbaum", "Mohammed bin Salman", "Ali Khamenei",
  // Royals and religious leaders
  "King Charles", "Queen Camilla", "Queen Elizabeth", "Prince Harry", "Prince William", "Meghan Markle", "Kate Middleton",
  "Princess Diana", "Pope Francis", "Pope Leo", "Dalai Lama",
  // Business and technology
  "Elon Musk", "Mark Zuckerberg", "Jeff Bezos", "Bill Gates", "Steve Jobs", "Tim Cook", "Sam Altman", "Jensen Huang",
  "Warren Buffett", "Sundar Pichai", "Satya Nadella",
  // Music
  "Taylor Swift", "Beyoncé", "Rihanna", "Lady Gaga", "Ariana Grande", "Billie Eilish", "Justin Bieber", "Selena Gomez",
  "Harry Styles", "Ed Sheeran", "Bad Bunny", "Dua Lipa", "Olivia Rodrigo", "Sabrina Carpenter", "Katy Perry",
  "Miley Cyrus", "Britney Spears", "Michael Jackson", "Elvis Presley", "Kanye West", "Jay-Z", "Kendrick Lamar",
  "Travis Scott", "Post Malone", "Nicki Minaj", "Cardi B", "Megan Thee Stallion", "Doja Cat", "Bruno Mars",
  "The Weeknd", "Elton John", "Paul McCartney", "Mick Jagger", "Bob Dylan", "Dolly Parton", "Snoop Dogg", "Eminem",
  "Shakira", "Lizzo", "Freddie Mercury", "John Lennon", "Whitney Houston", "Chappell Roan",
  // Film and television
  "Oprah Winfrey", "Oprah", "Tom Cruise", "Tom Hanks", "Brad Pitt", "Angelina Jolie", "Leonardo DiCaprio",
  "Scarlett Johansson", "Jennifer Lawrence", "Jennifer Aniston", "Jennifer Lopez", "Margot Robbie", "Ryan Reynolds",
  "Ryan Gosling", "Keanu Reeves", "Dwayne Johnson", "Will Smith", "Denzel Washington", "Morgan Freeman",
  "Samuel L. Jackson", "Robert Downey Jr.", "Johnny Depp", "Chris Hemsworth", "Chris Evans", "Chris Pratt",
  "Timothée Chalamet", "Zendaya", "Emma Watson", "Emma Stone", "Meryl Streep", "Nicole Kidman", "Natalie Portman",
  "Anne Hathaway", "Sydney Sweeney", "Pedro Pascal", "Cillian Murphy", "Jenna Ortega", "Florence Pugh", "Tom Holland",
  "Daniel Radcliffe", "Arnold Schwarzenegger", "Sylvester Stallone", "Jackie Chan", "Marilyn Monroe",
  "Audrey Hepburn", "Kim Kardashian", "Kylie Jenner", "Kendall Jenner", "Paris Hilton", "Joe Rogan", "MrBeast",
  "Gordon Ramsay", "Martha Stewart", "Jimmy Fallon", "Ellen DeGeneres",
  // Sport
  "LeBron James", "Michael Jordan", "Kobe Bryant", "Stephen Curry", "Serena Williams", "Venus Williams",
  "Cristiano Ronaldo", "Lionel Messi", "Neymar", "Kylian Mbappé", "Tom Brady", "Patrick Mahomes", "Travis Kelce",
  "Simone Biles", "Usain Bolt", "Tiger Woods", "Roger Federer", "Rafael Nadal", "Novak Djokovic", "Shohei Ohtani",
  "Caitlin Clark", "Muhammad Ali", "Conor McGregor", "Mike Tyson", "Lewis Hamilton", "Max Verstappen", "David Beckham",
  // Activists and others widely known by name
  "Greta Thunberg", "Malala Yousafzai",
];

/**
 * Letters that are not the Latin letters they are drawn as. A Cyrillic "а" and a Latin "a" are
 * different characters that render identically, so a name written with one of each passes a
 * keyword list and reads to a person as the name. This is the common ASCII-colliding subset of
 * Cyrillic and Greek, not a confusables table: a list of thirty is worth having and is not the same
 * as claiming the gate is Unicode-complete, which `PUBLIC_FIGURES`' own note already denies.
 */
const HOMOGLYPHS: Record<string,string> = {
  "\u0430":"a","\u0435":"e","\u043e":"o","\u0440":"p","\u0441":"c","\u0445":"x","\u0443":"y","\u0456":"i","\u0458":"j",
  "\u04cf":"l","\u0501":"d","\u0455":"s","\u043d":"h","\u043a":"k","\u043c":"m","\u0442":"t","\u0432":"b",
  "\u03bf":"o","\u03b1":"a","\u03b5":"e","\u03c1":"p","\u03c4":"t","\u03c5":"u","\u03b9":"i","\u03ba":"k",
  "\u03bd":"v","\u03c7":"x","\u03b7":"n","\u03bc":"u","\u0261":"g","\u0131":"i","\u2044":"/","\u2010":"-","\u2011":"-",
};
/**
 * Lower-case, strip accents, so "Beyoncé" and "BEYONCE" compare equal.
 *
 * HV-031-05: and strip the characters that are not there. `\p{Cf}` -- a zero-width space, a
 * zero-width joiner, a soft hyphen, a word joiner -- survives NFKD, is not in `\s`, and is not a
 * combining mark, so it was in none of the three things this fold removed. **One of them, inserted
 * after the first letter of each word, passed every prohibition in this package's own battery:
 * seventeen of seventeen.** The text renders unchanged to a person and tokenizes to the same thing
 * for a provider, so the refusal was the only thing that saw a difference.
 *
 * The repo already knew: `motion-graphics.ts` refuses `[\p{Cc}\p{Cs}\p{Cf}]` in every string a
 * title carries, and so do the graphic library and the composite plans. The knowledge never reached
 * the gate. Folding can only add refusals, so this is where it belongs rather than in twenty
 * validators.
 */
export function foldForMatching(value: string): string {
  // Case is folded before the homoglyphs are, so the table needs only the lower-case letters: a
  // Cyrillic capital \u0415 lower-cases to \u0430 and is then the same entry. The other order silently missed
  // every name written in capitals, which is how a cue is written.
  return value.normalize("NFKD")
    .replace(/[\p{M}\p{Cf}\p{Cs}\p{Co}]+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[\u0400-\u04ff\u0370-\u03ff\u0250-\u02af\u2010\u2011\u2044]/gu, character => HOMOGLYPHS[character] ?? character);
}

function namePattern(name: string): string {
  // Spaces, hyphens and dots are interchangeable separators; a trailing dot is optional.
  return foldForMatching(name).split(/[\s.-]+/).filter(Boolean)
    .map(part => part.replace(/[\\^$*+?()[\]{}|]/g, "\\$&")).join(String.raw`[\s.\-]*`);
}

/** One whole-word pattern over the folded text. */
export const PUBLIC_FIGURE_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:` + PUBLIC_FIGURES.map(namePattern).join("|") + String.raw`)(?![\p{L}\p{N}])`, "u");

export function namesPublicFigure(text: string): boolean {
  return PUBLIC_FIGURE_PATTERN.test(foldForMatching(text));
}
