
var reg = /^(10.10.2.)/;
if (window.location.hostname !== 'localhost' && !reg.test(window.location.hostname)) {
    if (window.location.protocol === 'http:') {
        window.location.href = window.location.href.replace('http:', 'https:')
    }
}
