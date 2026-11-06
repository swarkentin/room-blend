'use strict';
// Hand-picked crossover songs. Each one is tagged with both genres of a pair the genre graph links but the catalogue had
// no song for, so a room with one fan of each can blend on a real song instead of taking turns.
// Unlike the bulk files, these rows skip the per-genre and per-artist caps (catalog.js adds them last, so existing ids do not move),
// and a song already in the catalogue takes the tags given here.
// Format: [title, artist, "g1,g2,g3"], the first tag is the primary genre.
module.exports = {
  bridge: [
    // j-pop and k-pop; j-pop and dance pop / synth pop
    ['Make You Happy', 'NiziU', 'j-pop,k-pop,dance pop'], ['Lights', 'BTS', 'k-pop,j-pop'],
    ['Polyrhythm', 'Perfume', 'j-pop,synth pop,dance pop'], ['PONPONPON', 'Kyary Pamyu Pamyu', 'j-pop,dance pop,synth pop'],
    // bollywood and dance pop
    ['Jai Ho! (You Are My Destiny)', 'The Pussycat Dolls and A. R. Rahman', 'bollywood,dance pop,pop'], ['Chammak Challo', 'Akon and Hamsika Iyer', 'bollywood,dance pop,hip hop'],
    // brazilian and latin; brazilian and singer-songwriter
    ['Ai Se Eu Te Pego', 'Michel Teló', 'brazilian,latin,pop'], ['Lambada', 'Kaoma', 'brazilian,latin,dance pop'],
    ['Oceano', 'Djavan', 'brazilian,singer-songwriter'], ['Sampa', 'Caetano Veloso', 'brazilian,singer-songwriter'],
    // emo and indie
    ['Your Graduation', 'Modern Baseball', 'emo,indie'], ['Never Meant', 'American Football', 'emo,indie'],
    // idm and techno; idm and drum and bass
    ['Gantz Graf', 'Autechre', 'idm,techno'], ['Polynomial-C', 'Aphex Twin', 'idm,techno,electronic'],
    ['Come On My Selector', 'Squarepusher', 'idm,drum and bass'], ['Ni-Ten-Ichi-Ryu (Two Swords Technique)', 'Photek', 'drum and bass,idm'],
    // chillwave and lo-fi
    ['Still Sound', 'Toro y Moi', 'chillwave,lo-fi,indie'], ['Eyes Be Closed', 'Washed Out', 'chillwave,lo-fi,indie'],
    // blues and folk
    ['Where Did You Sleep Last Night', 'Lead Belly', 'folk,blues'], ['Fishin’ Blues', 'Taj Mahal', 'blues,folk'],
    // post-rock and electronic; soundtrack and synthwave
    ['Fragile', 'God Is an Astronaut', 'post-rock,electronic'], ['Radio Protector', '65daysofstatic', 'post-rock,electronic'],
    ['Stranger Things Theme', 'Kyle Dixon and Michael Stein', 'soundtrack,synthwave'],
  ],
};
