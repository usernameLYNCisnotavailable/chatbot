#include <vector>
#include <algorithm>
// -- SECTION: GAMBLE_COMMAND ---------------------------------------------------
// gamble.cpp — #included by reactor.cpp after sendToBot(), memoryGet(), memorySet()

void handleGamble(const std::string& username, const std::string& args, const std::string& channel) {
    auto memGet = [&](const std::string& k) -> std::string { return memoryGet(k); };
    auto memSet = [&](const std::string& k, const std::string& v) { memorySet(k, v); };

    auto sendToChat = [&](const std::string& msg) {
        WSADATA wsa;
        WSAStartup(MAKEWORD(2,2), &wsa);
        SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a;
        a.sin_family = AF_INET;
        a.sin_port = htons(9001);
        a.sin_addr.s_addr = inet_addr("127.0.0.1");
        connect(s, (sockaddr*)&a, sizeof(a));
        send(s, msg.c_str(), msg.size(), 0);
        closesocket(s);
        WSACleanup();
    };

    auto getCash = [&](const std::string& user) -> long long {
        std::string val = memGet("cash_" + user);
        if (val.empty()) { memSet("cash_" + user, "200"); return 200; }
        return std::stoll(val);
    };
    auto setCash = [&](const std::string& user, long long amount) {
        memSet("cash_" + user, std::to_string(amount));
    };
    auto getBank = [&](const std::string& user) -> long long {
        std::string val = memGet("bank_" + user);
        if (val.empty()) { memSet("bank_" + user, "500"); return 500; }
        return std::stoll(val);
    };
    auto setBank = [&](const std::string& user, long long amount) {
        memSet("bank_" + user, std::to_string(amount));
    };

    // ---- PARSE ARGS ----
    std::string sub = "";
    std::string arg1 = "";
    std::string arg2 = "";
    std::istringstream argStream(args);
    argStream >> sub >> arg1 >> arg2;

    srand((unsigned int)time(nullptr) ^ (unsigned int)(uintptr_t)&sub);

    // ---- SHARED GAME RUNNERS ------------------------------------------------

    auto runSlots = [&](long long bet) {
        long long cash = getCash(username);
        sendToChat("@" + username + " \xF0\x9F\x8E\xB0 Spinning...");
        Sleep(3000);
        std::vector<std::string> symbols = {
            "\xF0\x9F\x8D\x92", "\xF0\x9F\x8D\x8B", "\xF0\x9F\x8D\x8A",
            "\xF0\x9F\x8D\x87", "\xE2\xAD\x90", "\xF0\x9F\x92\x8E",
            "\x37\xEF\xB8\x8F\xE2\x83\xA3"
        };
        auto rollReel = [&]() -> int {
            int r = rand() % 18;
            if (r < 3) return 0; if (r < 6) return 1; if (r < 9) return 2;
            if (r < 12) return 3; if (r < 15) return 4; if (r < 17) return 5;
            return 6;
        };
        int r1 = rollReel(), r2 = rollReel(), r3 = rollReel();
        std::string display = "[ " + symbols[r1] + " | " + symbols[r2] + " | " + symbols[r3] + " ]";
        long long payout = 0;
        if (r1 == r2 && r2 == r3) {
            if (r3 == 6) payout = bet * 10;
            else if (r3 == 5) payout = bet * 7;
            else if (r3 == 4) payout = bet * 4;
            else payout = bet * 3;
            setCash(username, cash + payout);
            sendToChat("@" + username + " " + display + " \xF0\x9F\x8E\xA8 +$" + std::to_string(payout) + " \xF0\x9F\x92\xB5 $" + std::to_string(cash + payout));
        } else if (r1 == r2 || r2 == r3 || r1 == r3) {
            setCash(username, cash);
            sendToChat("@" + username + " " + display + " \xF0\x9F\x92\xB5 $" + std::to_string(cash));
        } else {
            setCash(username, cash - bet);
            sendToChat("@" + username + " " + display + " -$" + std::to_string(bet) + " \xF0\x9F\x92\xB5 $" + std::to_string(cash - bet));
        }
    };

    auto runCoinflip = [&](long long bet) {
        long long cash = getCash(username);
        bool win = (rand() % 2) == 0;
        if (win) {
            setCash(username, cash + bet);
            sendToChat("@" + username + " \xF0\x9F\x8E\xB4 +$" + std::to_string(bet) + " \xF0\x9F\x92\xB5 $" + std::to_string(cash + bet));
        } else {
            setCash(username, cash - bet);
            sendToChat("@" + username + " \xF0\x9F\x8E\xB4 -$" + std::to_string(bet) + " \xF0\x9F\x92\xB5 $" + std::to_string(cash - bet));
        }
    };

    auto runRoulette = [&](long long bet, const std::string& choice) {
        long long cash = getCash(username);
        int spin = rand() % 37;
        std::vector<int> reds = {1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36};
        bool isRed   = std::find(reds.begin(), reds.end(), spin) != reds.end();
        bool isGreen = (spin == 0);
        bool isBlack = !isRed && !isGreen;
        std::string color = isGreen ? "\xF0\x9F\x9F\xA2 Green" : (isRed ? "\xF0\x9F\x94\xB4 Red" : "\xE2\x9A\xAB Black");
        std::string spinStr = color + " " + std::to_string(spin);
        bool win = false;
        long long payout = 0;
        if (choice == "red"   && isRed)   { win = true; payout = bet; }
        else if (choice == "black" && isBlack) { win = true; payout = bet; }
        else if (choice == "green" && isGreen) { win = true; payout = bet * 14; }
        if (win) {
            setCash(username, cash + payout);
            sendToChat("@" + username + " " + spinStr + " \xF0\x9F\x8E\xA8 +$" + std::to_string(payout) + " \xF0\x9F\x92\xB5 $" + std::to_string(cash + payout));
        } else {
            setCash(username, cash - bet);
            sendToChat("@" + username + " " + spinStr + " -$" + std::to_string(bet) + " \xF0\x9F\x92\xB5 $" + std::to_string(cash - bet));
        }
    };

    // ---- NOT ENOUGH CASH HELPER ---------------------------------------------
    // Stores a pending gamble and asks user how much to withdraw (just type a number)
    auto notEnoughCash = [&](const std::string& type, long long bet, const std::string& extra = "") {
        long long cash = getCash(username);
        long long bank = getBank(username);
        if (bank <= 0 && cash <= 0) {
            sendToChat("@" + username + " you're broke.");
            return;
        }
        if (bank <= 0) {
            // Nothing in bank, some cash but not enough
            sendToChat("@" + username + " not enough \xF0\x9F\x92\xB5 cash \xe2\x80\x94 you have $" + std::to_string(cash) + " on hand, nothing in the bank.");
            return;
        }
        // Store pending so when they type a number it auto-runs
        memSet("pending_gamble_" + username, type + ":" + std::to_string(bet) + ":" + extra);
        sendToChat("@" + username + " not enough \xF0\x9F\x92\xB5 cash \xe2\x80\x94 \xF0\x9F\x8F\xA6 $" + std::to_string(bank) + " in the bank. How much would you like to withdraw? (type a number)");
    };

    // ---- PENDING WITHDRAW RESPONSE ------------------------------------------
    // If user types "!gamble 50" (just a number), treat as a withdraw response
    bool isNumber = !sub.empty();
    for (char c : sub) { if (!isdigit(c)) { isNumber = false; break; } }

    if (isNumber) {
        std::string pending = memGet("pending_gamble_" + username);
        if (pending.empty()) {
            sendToChat("@" + username + " you typed that wrong.");
            return;
        }
        long long withdrawAmt = std::stoll(sub);
        long long bank = getBank(username);
        long long cash = getCash(username);

        if (withdrawAmt <= 0 || withdrawAmt > bank) {
            sendToChat("@" + username + " you typed that wrong.");
            return;
        }

        // Silently withdraw
        setBank(username, bank - withdrawAmt);
        setCash(username, cash + withdrawAmt);
        long long newCash = cash + withdrawAmt;

        // Parse pending — format: "type:bet:extra"
        std::istringstream ps(pending);
        std::string pType, pBetStr, pExtra;
        std::getline(ps, pType, ':');
        std::getline(ps, pBetStr, ':');
        std::getline(ps, pExtra, ':');
        long long pBet = std::stoll(pBetStr);

        memSet("pending_gamble_" + username, ""); // clear pending

        if (newCash < pBet) {
            // Withdrew but still not enough — tell them quietly, no loop
            sendToChat("@" + username + " \xF0\x9F\x92\xB5 $" + std::to_string(newCash) + " (still not enough for $" + std::to_string(pBet) + ")");
            return;
        }

        // Fire the game
        if      (pType == "slots")    { runSlots(pBet); }
        else if (pType == "coinflip") { runCoinflip(pBet); }
        else if (pType == "roulette") { runRoulette(pBet, pExtra); }
        return;
    }

    // ---- COINFLIP -----------------------------------------------------------
    if (sub == "coinflip" || sub == "cf") {
        if (arg1.empty()) {
            sendToChat("@" + username + " you typed that wrong.");
        } else {
            long long bet = std::stoll(arg1);
            long long cash = getCash(username);
            if (bet <= 0) {
                sendToChat("@" + username + " you typed that wrong.");
            } else if (bet > cash) {
                notEnoughCash("coinflip", bet);
            } else {
                runCoinflip(bet);
            }
        }
    }

    // ---- SLOTS --------------------------------------------------------------
    else if (sub == "slots" || sub == "slot") {
        long long cash = getCash(username);
        long long bet = arg1.empty() ? std::max(1LL, cash / 10) : std::stoll(arg1);
        if (bet <= 0) {
            sendToChat("@" + username + " you typed that wrong.");
        } else if (bet > cash) {
            notEnoughCash("slots", bet);
        } else {
            runSlots(bet);
        }
    }

    // ---- ROULETTE -----------------------------------------------------------
    else if (sub == "roulette" || sub == "rl") {
        if (arg1.empty() || arg2.empty()) {
            sendToChat("@" + username + " you typed that wrong.");
        } else {
            long long bet = std::stoll(arg1);
            long long cash = getCash(username);
            if (bet <= 0) {
                sendToChat("@" + username + " you typed that wrong.");
            } else if (arg2 != "red" && arg2 != "black" && arg2 != "green") {
                sendToChat("@" + username + " you typed that wrong.");
            } else if (bet > cash) {
                notEnoughCash("roulette", bet, arg2);
            } else {
                runRoulette(bet, arg2);
            }
        }
    }

    // ---- UNRECOGNISED SUBCOMMAND -------------------------------------------
    else if (!sub.empty()) {
        sendToChat("@" + username + " you typed that wrong.");
    }

    // ---- BARE !gamble — show options ----------------------------------------
    else {
        sendToChat("@" + username + " \xF0\x9F\x8E\xB0 coinflip | slots | roulette");
    }
}